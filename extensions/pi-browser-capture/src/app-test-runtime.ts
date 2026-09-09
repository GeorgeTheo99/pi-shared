import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";
import { appTargetPolicy, startAppProxy } from "./app-test-policy.ts";

export const LIMITS = Object.freeze({ contexts: 4, steps: 30, timeoutMs: 10_000, runMs: 60_000,
	lifetimeMs: 15 * 60_000, traceMs: 60_000, entries: 100, entryChars: 512,
	snapshotChars: 16_000, screenshotBytes: 2 * 1024 * 1024, traceBytes: 16 * 1024 * 1024,
	artifactBytes: 32 * 1024 * 1024, artifacts: 20 });
export type Step = { action: "goto" | "click" | "fill" | "press" | "wait_visible" | "assert_visible" | "assert_text" | "assert_url";
	selector?: string; value?: string; timeoutMs?: number };
export type AppTestInput = { action: "create" | "close" | "configure" | "snapshot" | "run" | "trace_start" | "trace_stop";
	contextId?: string; device?: "desktop" | "mobile"; width?: number; height?: number; steps?: Step[] };
type Artifact = { kind: string; path: string; bytes: number };
type State = { id: string; owner: string; browser: Browser; context: BrowserContext; page: Page; dir: string;
	proxy: Awaited<ReturnType<typeof startAppProxy>>; timer: NodeJS.Timeout; device: "desktop" | "mobile";
	console: string[]; network: string[]; artifacts: Artifact[]; trace?: { timer: NodeJS.Timeout; stopping?: Promise<unknown> };
	lastTrace?: unknown; closed: boolean; closing?: Promise<void>; traceStarts: number };
const clip = (value: unknown, size: number = LIMITS.entryChars) => String(value).slice(0, size);
function logUrl(value: string) { try { const url = new URL(value); return clip(url.origin + url.pathname); } catch { return "[invalid URL]"; } }
function push(log: string[], value: string) { log.push(clip(value)); if (log.length > LIMITS.entries) log.shift(); }
function required(value: string | undefined, field: string) { if (typeof value !== "string" || !value || value.length > 4096) throw new Error(`${field} must contain 1–4096 characters`); return value; }
function viewport(input: AppTestInput, device: "desktop" | "mobile") {
	const width = input.width ?? (device === "mobile" ? 390 : 1440);
	const height = input.height ?? (device === "mobile" ? 844 : 1000);
	if (![width, height].every(n => Number.isInteger(n) && n >= 240 && n <= 1920)) throw new Error("Viewport dimensions must be integers from 240 to 1920");
	return { width, height };
}

export class AppTestRuntime {
	private root?: string;
	private states = new Map<string, State>();
	private queue: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private policy: ReturnType<typeof appTargetPolicy>;
	private artifactRoot: string;
	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.policy = appTargetPolicy((env.BROWSER_MCP_APP_BASE_URL ?? "http://127.0.0.1:8100") || undefined, env.BROWSER_MCP_APP_ALLOWED_HOSTS);
		const expandHome = (path: string) => path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
		this.artifactRoot = join(expandHome(env.BROWSER_MCP_APP_ARTIFACT_DIR || join(expandHome(env.BROWSER_MCP_STORAGE_ROOT || join(homedir(), ".local/share/browser-mcp")), "artifacts/app")), "app-test");
	}
	/** One queue prevents interleaved mutations and ownership/close races. */
	execute(owner: string, input: AppTestInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const task = this.queue.then(async () => {
			if (this.disposed) throw new Error("app_test runtime is closed");
			if (!owner) throw new Error("A Pi session owner is required");
			signal?.throwIfAborted();
			if (input.action === "create") return this.create(owner, input, signal);
			const state = this.states.get(input.contextId ?? "");
			if (!state || state.owner !== owner || state.closed) throw new Error("Unknown or foreign app_test context");
			if (input.action === "close") { await this.close(state); return { ok: true, closed: true, artifactsDeleted: true }; }
			const abort = () => { void this.close(state); };
			signal?.addEventListener("abort", abort, { once: true });
			try {
				switch (input.action) {
					case "configure": {
						if (input.device && input.device !== state.device) throw new Error("Device emulation is fixed at create; create a fresh context to change desktop/mobile");
						const size = viewport(input, state.device);
						await state.page.setViewportSize(size);
						return { ok: true, viewport: size, device: state.device };
					}
					case "snapshot": {
						const snapshot = await state.page.locator("body").ariaSnapshot({ timeout: LIMITS.timeoutMs, depth: 20 });
						return { ok: true, snapshot: clip(snapshot, LIMITS.snapshotChars), truncated: snapshot.length > LIMITS.snapshotChars };
					}
					case "run": return await this.run(state, input.steps, signal);
					case "trace_start": {
						if (state.trace) throw new Error("Trace already active");
						if (state.traceStarts >= 5) throw new Error("At most 5 traces per context");
						state.traceStarts++;
						await state.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
						state.lastTrace = undefined;
						state.trace = { timer: setTimeout(() => { void this.stopTrace(state, "duration limit"); }, LIMITS.traceMs) };
						state.trace.timer.unref();
						return { ok: true, tracing: true, maxDurationMs: LIMITS.traceMs, retention: "Until context close/expiry; size checked after trace export, not a disk quota" };
					}
					case "trace_stop": return { ok: true, trace: await this.stopTrace(state, "explicit stop") };
					default: throw new Error("Unsupported app_test action");
				}
			} finally {
				signal?.removeEventListener("abort", abort);
				if (state.closed) await this.close(state);
			}
		});
		this.queue = task.catch(() => {});
		return task;
	}
	private async create(owner: string, input: AppTestInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		if (this.states.size >= LIMITS.contexts) throw new Error("app_test context limit reached; close a context first");
		const device = input.device ?? "desktop";
		if (!["desktop", "mobile"].includes(device)) throw new Error("Unknown device");
		const size = viewport(input, device);
		if (!this.root) {
			await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
			this.root = await mkdtemp(join(this.artifactRoot, "runtime-"));
			await chmod(this.root, 0o700);
		}
		const network: string[] = [];
		const proxy = await startAppProxy(this.policy, url => push(network, `REFUSED ${logUrl(url)}`));
		let context: BrowserContext | undefined;
		let browser: Browser | undefined;
		let dir: string | undefined;
		try {
			signal?.throwIfAborted();
			dir = await mkdtemp(join(this.root, "context-"));
			await chmod(dir, 0o700);
			browser = await chromium.launch({ headless: true, tracesDir: join(dir, "trace-work"),
				args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
			context = await browser.newContext({ ...(device === "mobile" ? devices["iPhone 13"] : {}), viewport: size,
				deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false,
				proxy: { server: proxy.url, bypass: "<-loopback>" } });
			context.setDefaultTimeout(LIMITS.timeoutMs);
			context.setDefaultNavigationTimeout(LIMITS.timeoutMs);
			await context.routeWebSocket("**/*", socket => { push(network, `REFUSED WebSocket ${logUrl(socket.url())}`); socket.close(); });
			const page = await context.newPage();
			// Focused runner owns one page, not a tab manager. Proxy guards popup requests too.
			context.on("page", popup => { void popup.close().catch(() => {}); });
			const state = { id: randomUUID(), owner, browser, context, page, dir, proxy, device, console: [], network,
				artifacts: [], closed: false, traceStarts: 0 } as unknown as State;
			page.on("console", message => push(state.console, `${message.type()}: ${message.text()}`));
			page.on("pageerror", error => push(state.console, `pageerror: ${error.message}`));
			context.on("response", response => push(network, `${response.status()} ${response.request().method()} ${logUrl(response.url())}`));
			context.on("requestfailed", request => push(network, `FAILED ${request.method()} ${logUrl(request.url())}`));
			state.timer = setTimeout(() => { void this.close(state); }, LIMITS.lifetimeMs);
			state.timer.unref();
			this.states.set(state.id, state);
			if (signal?.aborted) { await this.close(state); signal.throwIfAborted(); }
			return { ok: true, contextId: state.id, device, viewport: size, isolated: true, lifetimeMs: LIMITS.lifetimeMs,
				limits: LIMITS, retention: "Artifacts deleted on close, session shutdown or context expiry. Crashes can leave private files; no hard disk quota." };
		} catch (error) {
			await browser?.close().catch(() => {}); await proxy.close(); if (dir) await rm(dir, { recursive: true, force: true }); throw error;
		}
	}
	private validateSteps(steps: Step[] | undefined): Step[] {
		if (!Array.isArray(steps) || !steps.length || steps.length > LIMITS.steps) throw new Error(`Provide 1–${LIMITS.steps} explicit steps`);
		for (const step of steps) {
			if (!step || !["goto", "click", "fill", "press", "wait_visible", "assert_visible", "assert_text", "assert_url"].includes(step.action)) throw new Error("Unsupported step action");
			if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > LIMITS.timeoutMs)) throw new Error("Step timeout out of bounds");
			if (!["goto", "assert_url"].includes(step.action)) required(step.selector, "selector");
			if (["goto", "press", "assert_url"].includes(step.action)) required(step.value, "value");
			if (["fill", "assert_text"].includes(step.action) && (typeof step.value !== "string" || step.value.length > 4096)) throw new Error("value must be a string of at most 4096 characters");
			if (["goto", "assert_url"].includes(step.action)) this.policy.resolve(step.value!);
		}
		return steps;
	}
	private async run(state: State, rawSteps: Step[] | undefined, signal?: AbortSignal) {
		const steps = this.validateSteps(rawSteps); // Validate entire sequence BEFORE any mutation.
		const deadline = Date.now() + LIMITS.runMs;
		const results: { step: number; action: string; ok: boolean }[] = [];
		for (const [index, step] of steps.entries()) {
			try {
				signal?.throwIfAborted();
				if (state.closed || Date.now() >= deadline) throw new Error("Context closed or run deadline exceeded");
				const timeout = Math.max(1, Math.min(step.timeoutMs ?? LIMITS.timeoutMs, deadline - Date.now()));
				const locator = state.page.locator(step.selector ?? "body");
				switch (step.action) {
					case "goto": { const response = await state.page.goto(this.policy.resolve(step.value!), { timeout, waitUntil: "domcontentloaded" });
						if (response && response.status() >= 400) throw new Error(`Navigation returned HTTP ${response.status()}`); break; }
					case "click": await locator.click({ timeout }); break;
					case "fill": await locator.fill(step.value!, { timeout }); break;
					case "press": await locator.press(step.value!, { timeout }); break;
					case "wait_visible": await locator.waitFor({ state: "visible", timeout }); break;
					case "assert_visible": if (!await locator.isVisible()) throw new Error("Expected visible element"); break;
					case "assert_text": if (await locator.innerText({ timeout }) !== step.value) throw new Error("Text assertion failed (exact match)"); break;
					case "assert_url": if (state.page.url() !== this.policy.resolve(step.value!)) throw new Error("URL assertion failed (exact match)"); break;
				}
				results.push({ step: index + 1, action: step.action, ok: true });
			} catch (error) {
				results.push({ step: index + 1, action: step.action, ok: false });
				return { ok: false, failedStep: index + 1, error: clip(error), results, skipped: steps.length - index - 1,
					artifacts: state.closed ? [] : await this.failureEvidence(state), contextClosed: state.closed };
			}
		}
		return { ok: true, results };
	}
	private async artifact(state: State, kind: string, extension: string, data: Buffer | string, limit: number): Promise<Artifact> {
		const bytes = Buffer.byteLength(data);
		if (state.closed || bytes > limit || state.artifacts.length >= LIMITS.artifacts || state.artifacts.reduce((n, a) => n + a.bytes, 0) + bytes > LIMITS.artifactBytes)
			throw new Error("Artifact retention limit reached or context closed");
		const path = join(state.dir, `${kind}-${randomUUID()}.${extension}`);
		await writeFile(path, data, { mode: 0o600, flag: "wx" });
		const result = { kind, path, bytes }; state.artifacts.push(result); return result;
	}
	private async failureEvidence(state: State) {
		const evidence: unknown[] = [];
		for (const [kind, log] of [["console", state.console], ["network", state.network]] as const) {
			try { evidence.push(await this.artifact(state, kind, "json", JSON.stringify(log), 256 * 1024)); }
			catch (error) { evidence.push({ kind, error: clip(error) }); }
		}
		try { evidence.push(await this.artifact(state, "screenshot", "png", await state.page.screenshot({ fullPage: false, timeout: 3000 }), LIMITS.screenshotBytes)); }
		catch (error) { evidence.push({ kind: "screenshot", error: clip(error) }); }
		return evidence;
	}
	private async stopTrace(state: State, reason: string): Promise<unknown> {
		const trace = state.trace;
		if (!trace) return state.lastTrace ?? { tracing: false, reason: "No active trace" };
		if (trace.stopping) return trace.stopping;
		clearTimeout(trace.timer);
		trace.stopping = (async () => {
			const path = join(state.dir, `trace-${randomUUID()}.zip`);
			try {
				await state.context.tracing.stop({ path });
				await chmod(path, 0o600);
				const bytes = (await stat(path)).size;
				if (state.closed || bytes > LIMITS.traceBytes || state.artifacts.length >= LIMITS.artifacts || state.artifacts.reduce((n, a) => n + a.bytes, 0) + bytes > LIMITS.artifactBytes) {
					await rm(path, { force: true }); return { saved: false, reason: "Trace exceeded retention limit or context closed" };
				}
				const artifact = { kind: "trace", path, bytes }; state.artifacts.push(artifact);
				return { saved: true, reason, artifact };
			} catch (error) { await rm(path, { force: true }).catch(() => {}); return { saved: false, error: clip(error) }; }
		})();
		state.lastTrace = await trace.stopping;
		state.trace = undefined;
		return state.lastTrace;
	}
	private close(state: State): Promise<void> {
		if (state.closing) return state.closing;
		state.closed = true;
		state.closing = (async () => {
			clearTimeout(state.timer);
			if (state.trace) clearTimeout(state.trace.timer);
			await state.browser.close().catch(() => {});
			if (state.trace?.stopping) await state.trace.stopping;
			await state.proxy.close();
			await rm(state.dir, { recursive: true, force: true });
			this.states.delete(state.id);
		})();
		return state.closing;
	}
	async dispose() {
		this.disposed = true;
		await this.queue;
		await Promise.all([...this.states.values()].map(state => this.close(state)));
		if (this.root) await rm(this.root, { recursive: true, force: true });
	}
}
