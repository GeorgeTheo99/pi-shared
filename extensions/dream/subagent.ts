import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { DreamAgentResult, UsageStats } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Adapted from spawn-subagent/index.ts ---

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-dream-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	});
	return { dir, filePath };
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

// --- Agent prompt resolution ---

export function getAgentPromptPath(agentName: string): string {
	return path.join(__dirname, "agents", `${agentName}.md`);
}

export function readAgentPrompt(agentName: string): string {
	const filePath = getAgentPromptPath(agentName);
	const content = fs.readFileSync(filePath, "utf8");
	// Strip YAML frontmatter if present
	const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return match ? match[1].trim() : content.trim();
}

// --- Dream agent spawning ---

export async function spawnDreamAgent(options: {
	agentName: string;
	task: string;
	cwd: string;
	model?: string;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}): Promise<DreamAgentResult> {
	const systemPrompt = readAgentPrompt(options.agentName);
	const args = ["--mode", "json", "-p", "--no-session"];

	if (options.model) args.push("--model", options.model);
	// Dream agents get read-only tools for verification
	args.push("--tools", "read,grep,find,ls,bash");

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	const usage = emptyUsage();
	const messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> = [];

	try {
		const tmp = await writePromptToTempFile(options.agentName, systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPath);
		args.push(`Task: ${options.task}`);

		const invocation = getPiInvocation(args);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line);
						if (event.type === "message_end" && event.message) {
							const msg = event.message;
							messages.push(msg);
							if (msg.role === "assistant") {
								usage.turns++;
								if (msg.usage) {
									usage.input += msg.usage.input || 0;
									usage.output += msg.usage.output || 0;
									usage.cacheRead += msg.usage.cacheRead || 0;
									usage.cacheWrite += msg.usage.cacheWrite || 0;
									usage.cost += msg.usage.cost?.total || 0;
								}
								// Report progress
								const textBlock = msg.content?.find((b: any) => b.type === "text");
								if (textBlock?.text && options.onProgress) {
									options.onProgress(textBlock.text.slice(0, 200));
								}
							}
						}
					} catch {
						// skip unparseable lines
					}
				}
			});

			proc.stderr.on("data", () => {
				// ignore stderr
			});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						const event = JSON.parse(buffer);
						if (event.type === "message_end" && event.message) {
							messages.push(event.message);
						}
					} catch {
						// ignore
					}
				}
				resolve(code ?? 0);
			});

			proc.on("error", () => resolve(1));

			if (options.signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000).unref?.();
				};
				if (options.signal.aborted) killProc();
				else options.signal.addEventListener("abort", killProc, { once: true });
			}
		});

		// Extract final assistant text
		let output = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role !== "assistant") continue;
			for (const part of messages[i].content) {
				if (part.type === "text" && part.text) {
					output = part.text;
					break;
				}
			}
			if (output) break;
		}

		if (wasAborted) {
			return { success: false, output, usage, error: "Dream agent was aborted" };
		}

		return {
			success: exitCode === 0 && output.length > 0,
			output,
			usage,
			error: exitCode !== 0 ? `Dream agent exited with code ${exitCode}` : undefined,
		};
	} finally {
		if (tmpPath) await fs.promises.unlink(tmpPath).catch(() => undefined);
		if (tmpDir) await fs.promises.rmdir(tmpDir).catch(() => undefined);
	}
}

// --- Parse dream agent output ---

export function parseDreamOutput<T>(text: string): T | null {
	// Try direct parse
	try {
		return JSON.parse(text) as T;
	} catch {
		// continue to fallback strategies
	}

	// Try extracting from markdown code fence
	const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	if (fenceMatch) {
		try {
			return JSON.parse(fenceMatch[1]) as T;
		} catch {
			// continue
		}
	}

	// Try finding JSON object or array by brace matching
	const startObj = text.indexOf("{");
	const startArr = text.indexOf("[");
	const start = startObj >= 0 && (startArr < 0 || startObj < startArr) ? startObj : startArr;
	if (start < 0) return null;

	const openChar = text[start];
	const closeChar = openChar === "{" ? "}" : "]";

	// Find matching close from the end
	const end = text.lastIndexOf(closeChar);
	if (end <= start) return null;

	try {
		return JSON.parse(text.slice(start, end + 1)) as T;
	} catch {
		return null;
	}
}
