import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "../spawn-subagent/agents.js";
import type { SubagentConfig } from "./subagent-config.ts";
import type { SchedulerLeaseInfo, SubagentExecutionGroup } from "./subagent-scheduler.ts";
import { runManagedProcess } from "./managed-process.ts";
import { truncateUtf8Head } from "./text-bounds.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface PiAgentUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type PiAgentStatus = "queued" | "starting" | "running" | "completed" | "failed" | "canceled";

export interface PiAgentResult {
	agent: string;
	agentSource: AgentConfig["source"] | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: PiAgentUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	status: PiAgentStatus;
	startedAt?: string;
	updatedAt: string;
	completedAt?: string;
	activeTool?: string;
	activeToolCallId?: string;
	lastEvent?: string;
	lastText?: string;
	pid?: number;
	queueWaitMs?: number;
	timedOut?: boolean;
	captureTruncated?: boolean;
}

export interface RunPiAgentOptions {
	config: SubagentConfig;
	group: SubagentExecutionGroup;
	defaultCwd: string;
	agents: AgentConfig[];
	agentName: string;
	task: string;
	cwd?: string;
	model?: string;
	parentModel?: string;
	agentDir?: string;
	signal?: AbortSignal;
	onUpdate?: (result: PiAgentResult) => void;
}

function emptyUsage(): PiAgentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function extractMessageText(message: Message | undefined): string {
	if (!message) return "";
	const parts = Array.isArray(message.content) ? message.content : [];
	return parts
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function extractToolResultText(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content
		.map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function compactAssistantMessage(message: Message, maxBytes: number): Message {
	let serializedBytes = 0;
	try {
		serializedBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
	} catch {
		serializedBytes = maxBytes + 1;
	}
	if (serializedBytes <= maxBytes) return message;

	const clone: any = { ...message };
	const content = Array.isArray((message as any).content) ? (message as any).content : [];
	const perPart = Math.max(1024, Math.floor(maxBytes / Math.max(1, content.length)));
	clone.content = content.slice(0, 64).map((part: any) => {
		if (part?.type === "text" && typeof part.text === "string") {
			return { ...part, text: truncateUtf8Head(part.text, perPart, "message text") };
		}
		if (part?.type === "toolCall") {
			let argumentBytes = 0;
			try {
				argumentBytes = Buffer.byteLength(JSON.stringify(part.arguments), "utf8");
			} catch {
				argumentBytes = perPart + 1;
			}
			return argumentBytes <= perPart ? part : { ...part, arguments: { _truncated: true } };
		}
		return part;
	});
	return clone as Message;
}

function pushBoundedMessage(result: PiAgentResult, message: Message, maxBytes: number): void {
	const compact = compactAssistantMessage(message, Math.max(4096, Math.floor(maxBytes / 2)));
	result.messages.push(compact);
	let total = result.messages.reduce((sum, item) => {
		try {
			return sum + Buffer.byteLength(JSON.stringify(item), "utf8");
		} catch {
			return sum;
		}
	}, 0);
	while (result.messages.length > 1 && total > maxBytes) {
		const removed = result.messages.shift();
		if (removed) {
			try {
				total -= Buffer.byteLength(JSON.stringify(removed), "utf8");
			} catch {
				// Ignore serialization failures while pruning.
			}
		}
		result.captureTruncated = true;
	}
	if (result.messages.length > 64) {
		result.messages.splice(0, result.messages.length - 64);
		result.captureTruncated = true;
	}
}

function cloneProgress(result: PiAgentResult): PiAgentResult {
	return { ...result, messages: [...result.messages], usage: { ...result.usage } };
}

function updateProgress(result: PiAgentResult, patch: Partial<PiAgentResult>): void {
	Object.assign(result, patch, { updatedAt: new Date().toISOString() });
}

export function getFinalAssistantOutput(messages: Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
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

function expandTilde(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function resolveCwd(defaultCwd: string, cwd?: string): string {
	if (!cwd) return defaultCwd;
	const expanded = expandTilde(cwd);
	return path.isAbsolute(expanded) ? expanded : path.resolve(defaultCwd, expanded);
}

function canonicalAgentDir(agentDir: string): string {
	const expanded = path.resolve(expandTilde(agentDir));
	try {
		return fs.realpathSync.native(expanded);
	} catch {
		return expanded;
	}
}

function defaultAgentDir(): string {
	return canonicalAgentDir(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

function authFileForAgentDir(agentDir?: string): string {
	return path.join(agentDir ? canonicalAgentDir(agentDir) : defaultAgentDir(), "auth.json");
}

function hasOpenAICodexSubscriptionAuth(agentDir?: string): boolean {
	try {
		const raw = fs.readFileSync(authFileForAgentDir(agentDir), "utf8");
		const auth = JSON.parse(raw) as Record<string, unknown>;
		const entry = auth[OPENAI_CODEX_PROVIDER];
		return Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "oauth");
	} catch {
		return false;
	}
}

function openAICodexSubscriptionAgentDir(preferredAgentDir?: string): string | undefined {
	const candidates = [preferredAgentDir, defaultAgentDir(), OPENAI_CODEX_AGENT_DIR].filter((item): item is string => Boolean(item));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const canonical = canonicalAgentDir(candidate);
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		if (hasOpenAICodexSubscriptionAuth(canonical)) return canonical;
	}
	return undefined;
}

function splitThinkingSuffix(model: string): { base: string; suffix: string } {
	const colon = model.lastIndexOf(":");
	if (colon <= 0) return { base: model, suffix: "" };
	const maybeLevel = model.slice(colon + 1);
	if (!THINKING_LEVELS.has(maybeLevel)) return { base: model, suffix: "" };
	return { base: model.slice(0, colon), suffix: model.slice(colon) };
}

function isGptModelId(modelId: string): boolean {
	return /^(?:gpt|chatgpt|o[1-9])(?:[-.]|$)/i.test(modelId);
}

function parseProviderModel(model: string): { provider?: string; modelId: string; suffix: string } {
	const { base, suffix } = splitThinkingSuffix(model.trim());
	const slash = base.indexOf("/");
	return { provider: slash > 0 ? base.slice(0, slash) : undefined, modelId: slash > 0 ? base.slice(slash + 1) : base, suffix };
}

function isGptFamilyModel(model: string | undefined): boolean {
	if (!model) return false;
	const { provider, modelId } = parseProviderModel(model);
	return provider === OPENAI_CODEX_PROVIDER || isGptModelId(modelId);
}

function subagentProfileForModel(model: string | undefined, requestedAgentDir?: string): string | undefined {
	const explicitAgentDir = requestedAgentDir ? canonicalAgentDir(requestedAgentDir) : undefined;
	if (!isGptFamilyModel(model)) return explicitAgentDir;
	return openAICodexSubscriptionAgentDir(explicitAgentDir) ?? explicitAgentDir;
}

function preferOpenAICodexSubscription(model: string | undefined): string | undefined {
	if (!model) return model;
	const { provider, modelId, suffix } = parseProviderModel(model);
	if (!modelId || provider === OPENAI_CODEX_PROVIDER || !isGptModelId(modelId)) return model;
	return `${OPENAI_CODEX_PROVIDER}/${modelId}${suffix}`;
}

function allowedAgentDirs(): Set<string> {
	const dirs = [path.join(os.homedir(), ".pi-omlx", "agent"), OPENAI_CODEX_AGENT_DIR];
	if (process.env.PI_CODING_AGENT_DIR) dirs.push(process.env.PI_CODING_AGENT_DIR);
	dirs.push(...(process.env.PI_SPAWN_SUBAGENT_ALLOWED_AGENT_DIRS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
	return new Set(dirs.map(canonicalAgentDir));
}

export function untrustedSubagentProfileDirs(agentDirs: Array<string | undefined>): string[] {
	const allowed = allowedAgentDirs();
	const seen = new Set<string>();
	const untrusted: string[] = [];
	for (const agentDir of agentDirs) {
		if (!agentDir) continue;
		const canonical = canonicalAgentDir(agentDir);
		if (allowed.has(canonical) || seen.has(canonical)) continue;
		seen.add(canonical);
		untrusted.push(canonical);
	}
	return untrusted;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}-${crypto.randomUUID()}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
	});
	return { dir, filePath };
}

export async function runPiAgent(options: RunPiAgentOptions): Promise<PiAgentResult> {
	const agent = options.agents.find((candidate) => candidate.name === options.agentName);
	const result: PiAgentResult = {
		agent: options.agentName,
		agentSource: agent?.source ?? "unknown",
		task: options.task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		status: "queued",
		updatedAt: new Date().toISOString(),
		lastEvent: "queued for global subagent slot",
	};
	const emit = () => options.onUpdate?.(cloneProgress(result));
	const boundedLiveText = (text: string) => truncateUtf8Head(text, options.config.maxCaptureBytes, "live output");

	if (!agent) {
		const available = options.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
		updateProgress(result, {
			exitCode: 1,
			status: "failed",
			completedAt: new Date().toISOString(),
			errorMessage: `Unknown agent: "${options.agentName}". Available agents: ${available}.`,
			lastEvent: "unknown agent",
		});
		emit();
		return result;
	}

	const taskBytes = Buffer.byteLength(options.task, "utf8");
	if (taskBytes > options.config.maxTaskBytes) {
		updateProgress(result, {
			exitCode: 1,
			status: "failed",
			completedAt: new Date().toISOString(),
			errorMessage: `Subagent task is ${taskBytes} bytes; max is ${options.config.maxTaskBytes}.`,
			lastEvent: "task rejected by size limit",
		});
		emit();
		return result;
	}

	const requestedModel = options.model ?? agent.model ?? options.parentModel;
	const agentDir = subagentProfileForModel(requestedModel, options.agentDir);
	const model = preferOpenAICodexSubscription(requestedModel);
	result.model = model;
	const args = ["--mode", "json", "-p", "--no-session"];
	if (options.config.depth + 1 >= options.config.maxDepth) {
		args.push("--exclude-tools", "spawn_subagent,workflow");
	}
	if (model) args.push("--model", model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | undefined;
	let tmpPromptPath: string | undefined;
	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		args.push(`Task: ${options.task}`);
		const invocation = getPiInvocation(args);
		const cwd = resolveCwd(options.defaultCwd, options.cwd);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
			PI_SUBAGENT_DEPTH: String(options.config.depth + 1),
		};

		const managed = await options.group.run(
			{
				label: `${agent.name}: ${options.task.slice(0, 80)}`,
				onState: (state, queueWaitMs) => {
					updateProgress(result, {
						status: state === "running" ? "starting" : "queued",
						queueWaitMs,
						lastEvent: state === "running" ? "acquired global subagent slot" : "queued for global subagent slot",
					});
					emit();
				},
			},
			async (lease: SchedulerLeaseInfo, runSignal: AbortSignal) => {
				result.queueWaitMs = lease.queueWaitMs;
				return runManagedProcess({
					command: invocation.command,
					args: invocation.args,
					cwd,
					env,
					signal: runSignal,
					runTimeoutMs: options.config.runTimeoutMs,
					termGraceMs: options.config.termGraceMs,
					maxStderrBytes: options.config.maxStderrBytes,
					maxEventBytes: options.config.maxEventBytes,
					onSpawn: (pid) => {
						updateProgress(result, {
							pid,
							status: "running",
							startedAt: new Date().toISOString(),
							lastEvent: pid ? `started child process pid ${pid}` : "started child process",
						});
						emit();
					},
					onStdoutLine: (line) => {
						if (!line.trim()) return;
						let event: any;
						try {
							event = JSON.parse(line);
						} catch {
							return;
						}
						if (event.type === "message_update" && event.message) {
							const text = extractMessageText(event.message as Message);
							updateProgress(result, {
								status: "running",
								lastEvent: "streaming assistant response",
								lastText: text ? boundedLiveText(text) : result.lastText,
							});
							emit();
						}
						if (event.type === "tool_execution_start") {
							updateProgress(result, {
								status: "running",
								activeTool: String(event.toolName ?? "unknown"),
								activeToolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
								lastEvent: `running tool ${String(event.toolName ?? "unknown")}`,
							});
							emit();
						}
						if (event.type === "tool_execution_update") {
							const text = extractToolResultText(event.partialResult);
							updateProgress(result, {
								status: "running",
								lastEvent: `tool ${String(event.toolName ?? "unknown")} update`,
								lastText: text ? boundedLiveText(text) : result.lastText,
							});
							emit();
						}
						if (event.type === "tool_execution_end") {
							const text = extractToolResultText(event.result);
							updateProgress(result, {
								status: "running",
								activeTool: undefined,
								activeToolCallId: undefined,
								lastEvent: `tool ${String(event.toolName ?? "unknown")} ${event.isError ? "failed" : "completed"}`,
								lastText: text ? boundedLiveText(text) : result.lastText,
							});
							emit();
						}
						if (event.type === "message_end" && event.message) {
							const message = event.message as Message;
							if (message.role === "assistant") {
								const text = extractMessageText(message);
								pushBoundedMessage(result, message, options.config.maxCaptureBytes);
								result.usage.turns++;
								const usage = message.usage;
								if (usage) {
									result.usage.input += usage.input || 0;
									result.usage.output += usage.output || 0;
									result.usage.cacheRead += usage.cacheRead || 0;
									result.usage.cacheWrite += usage.cacheWrite || 0;
									result.usage.cost += usage.cost?.total || 0;
									result.usage.contextTokens = usage.totalTokens || 0;
								}
								if (!result.model && message.model) result.model = message.model;
								if (message.stopReason) result.stopReason = message.stopReason;
								if (message.errorMessage) result.errorMessage = message.errorMessage;
								updateProgress(result, {
									status: "running",
									lastEvent: "assistant turn completed",
									lastText: text ? boundedLiveText(text) : result.lastText,
								});
								emit();
							}
						}
						if (event.type === "tool_result_end" && event.message) {
							const text = extractMessageText(event.message as Message);
							updateProgress(result, {
								status: "running",
								lastEvent: "tool result captured",
								lastText: text ? boundedLiveText(text) : result.lastText,
							});
							emit();
						}
					},
				});
			},
		);

		result.exitCode = managed.exitCode;
		result.stderr = managed.stderr;
		if (managed.errorMessage) result.errorMessage = managed.errorMessage;
		if (managed.terminationReason === "aborted") result.stopReason = "aborted";
		if (managed.terminationReason === "timeout") result.timedOut = true;
		const failed =
			managed.exitCode !== 0 ||
			managed.terminationReason !== undefined ||
			result.stopReason === "error" ||
			result.stopReason === "aborted";
		updateProgress(result, {
			status: managed.terminationReason === "aborted" ? "canceled" : failed ? "failed" : "completed",
			completedAt: new Date().toISOString(),
			activeTool: undefined,
			activeToolCallId: undefined,
			lastEvent:
				managed.terminationReason === "aborted"
					? "subagent aborted"
					: managed.terminationReason === "timeout"
						? "subagent timed out"
						: managed.terminationReason === "output_limit"
							? "subagent stopped after exceeding output limit"
							: failed
								? `subagent exited with code ${managed.exitCode}`
								: "subagent completed",
		});
		emit();
		return result;
	} catch (error: unknown) {
		const canceled = options.signal?.aborted || (error instanceof Error && error.name === "AbortError");
		updateProgress(result, {
			exitCode: 1,
			status: canceled ? "canceled" : "failed",
			stopReason: canceled ? "aborted" : result.stopReason,
			errorMessage: error instanceof Error ? error.message : String(error),
			completedAt: new Date().toISOString(),
			activeTool: undefined,
			activeToolCallId: undefined,
			lastEvent: canceled ? "subagent aborted before start" : "subagent execution failed",
		});
		emit();
		return result;
	} finally {
		if (tmpPromptPath) await fs.promises.unlink(tmpPromptPath).catch(() => undefined);
		if (tmpPromptDir) await fs.promises.rmdir(tmpPromptDir).catch(() => undefined);
	}
}
