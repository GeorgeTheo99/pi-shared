import { constants, realpathSync, statSync, accessSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, dirname } from "node:path";
import { startManagedProcess } from "../_shared/managed-process.ts";

export type SetupAction = "plan" | "status" | "apply" | "check";
export interface SetupReport {
	schemaVersion: 1;
	component: "peekaboo";
	action: SetupAction;
	ok: boolean;
	summary: string;
	actions: string[];
	warnings: string[];
	errors: string[];
	nextSteps: string[];
	planId?: string;
	evidence: {
		binaryPath: string | null;
		binaryPresent: boolean;
		configuration: "missing" | "matching" | "conflict" | "invalid";
		runnable: "not-tested" | "yes" | "no";
		permissions: Record<"screenRecording" | "accessibility" | "eventSynthesizing", "unknown" | "granted" | "denied">;
		mcp: "not-tested" | "connected" | "failed";
		toolCount: number | null;
		desktop: "not-tested";
	};
}

const MAX_OUTPUT = 64 * 1024;
export function parseReport(text: string, action: SetupAction): SetupReport {
	if (Buffer.byteLength(text) > MAX_OUTPUT) throw new Error("Setup result exceeded its size limit.");
	let value: any;
	try { value = JSON.parse(text); } catch { throw new Error("The setup backend did not return versioned JSON. Update the owning pi-shared installation; no automatic update was attempted."); }
	const strings = (v: unknown) => Array.isArray(v) && v.length <= 50 && v.every(s => typeof s === "string" && s.length <= 4096);
	const e = value?.evidence;
	if (value?.schemaVersion !== 1 || value.component !== "peekaboo" || value.action !== action ||
		typeof value.ok !== "boolean" || typeof value.summary !== "string" || value.summary.length > 4096 ||
		!["actions", "warnings", "errors", "nextSteps"].every(k => strings(value[k])) ||
		(value.planId !== undefined && !/^[a-f0-9]{64}$/.test(value.planId)) ||
		!e || !(e.binaryPath === null || typeof e.binaryPath === "string" && isAbsolute(e.binaryPath)) ||
		typeof e.binaryPresent !== "boolean" || !["missing", "matching", "conflict", "invalid"].includes(e.configuration) ||
		!["not-tested", "yes", "no"].includes(e.runnable) || !["not-tested", "connected", "failed"].includes(e.mcp) ||
		!(e.toolCount === null || Number.isSafeInteger(e.toolCount) && e.toolCount >= 0 && e.toolCount <= 10000) ||
		e.desktop !== "not-tested" || !["screenRecording", "accessibility", "eventSynthesizing"].every(k =>
			["unknown", "granted", "denied"].includes(e.permissions?.[k]))) {
		throw new Error("Unsupported or malformed Peekaboo setup response. Update the owning pi-shared installation; desktop readiness is unknown.");
	}
	return value;
}

// Homebrew commonly makes its prefix/Cellar admin-group writable on macOS.
// Accept only those two directories for this exact package layout, never an
// arbitrary group-writable source checkout, package subdirectory or executable.
export function homebrewAdminAncestor(executable: string, ancestor: string, gid: number, mode: number,
	platform: string = process.platform, groups: number[] = process.getgroups?.() ?? []): boolean {
	const cellar = executable.match(/^(\/opt\/homebrew|\/usr\/local)\/Cellar\/pi-shared\/[^/]+\/bin\/pi-shared$/)?.[1];
	return platform === "darwin" && cellar !== undefined &&
		(ancestor === cellar || ancestor === `${cellar}/Cellar`) && gid === 80 && groups.includes(80) &&
		!(mode & 0o002);
}

// Deliberately do not search the project or PATH for an installer to execute.
export function resolveSetupExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_SHARED_SETUP_BIN;
	const candidates = override !== undefined ? [override] : ["/opt/homebrew/bin/pi-shared", "/usr/local/bin/pi-shared"];
	for (const candidate of candidates) {
		if (!isAbsolute(candidate) || /[\x00-\x1f\x7f]/.test(candidate)) throw new Error("PI_SHARED_SETUP_BIN must be an absolute executable path.");
		try {
			const resolved = realpathSync(candidate);
			const file = statSync(resolved);
			const uid = process.getuid?.();
			if (!file.isFile() || (file.uid !== 0 && file.uid !== uid) || (file.mode & 0o022)) throw new Error("Unsafe setup executable ownership or permissions.");
			for (let parent = dirname(resolved); parent !== dirname(parent); parent = dirname(parent)) {
				const info = statSync(parent);
				// A sticky temporary root is permitted for explicitly selected development fixtures.
				if ((info.uid !== 0 && info.uid !== uid) || ((info.mode & 0o022) && !(info.mode & 0o1000) &&
					!homebrewAdminAncestor(resolved, parent, info.gid, info.mode))) throw new Error("Unsafe setup executable ancestor.");
			}
			accessSync(resolved, constants.X_OK);
			return resolved;
		} catch (error: any) {
			if (!override && error?.code === "ENOENT") continue;
			throw error;
		}
	}
	throw new Error("The owning pi-shared setup CLI was not found. Install it first, or explicitly set PI_SHARED_SETUP_BIN to a trusted source installation. Project/PATH discovery is not used.");
}

export async function runBackend(command: string, action: SetupAction, extra: string[], signal: AbortSignal): Promise<SetupReport> {
	if (signal.aborted) throw new Error("Setup canceled before execution.");
	let stdout = "";
	let bytes = 0;
	const env: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: "1", PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" };
	delete env.PYTHONPATH;
	delete env.PYTHONHOME;
	const handle = startManagedProcess({
		command, args: ["peekaboo", action, "--json", ...extra], cwd: homedir(), env, signal,
		runTimeoutMs: action === "apply" ? 600_000 : 90_000, termGraceMs: 1000,
		maxStderrBytes: 4096, maxEventBytes: MAX_OUTPUT, limitStdoutEvents: false, cleanupOnExit: true,
		onStdoutChunk(chunk) {
			bytes += Buffer.byteLength(chunk);
			if (bytes > MAX_OUTPUT) handle.terminate("output_limit", "Setup result exceeded its size limit.");
			else stdout += chunk;
		},
	});
	const result = await handle.completion;
	if (signal.aborted || result.terminationReason || result.cleanup !== "confirmed") {
		throw new Error(`Setup ${result.terminationReason ?? "cleanup-unconfirmed"}. Changes may be partial; inspect /setup peekaboo before retrying. No automatic retry was attempted.`);
	}
	const report = parseReport(stdout, action);
	if ((result.exitCode === 0) !== report.ok) throw new Error("Setup exit status contradicted its report; result is unverified.");
	return report;
}
