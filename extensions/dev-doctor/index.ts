import { fileURLToPath } from "node:url";
import { Type } from "@mariozechner/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { runManagedProcess } from "../_shared/managed-process.ts";
import { createMcpInventory, formatMcpInventory } from "./mcp-inventory.ts";

const DOCTOR = fileURLToPath(new URL("../../bin/pi-doctor", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_REPORT_BYTES = 32 * 1024;

export default function (pi: ExtensionAPI) {
	const mcpInventory = createMcpInventory(pi);
	pi.registerCommand("mcp-connections", {
		description: "Show adapter-managed and native-wrapper MCP inventory without connecting to services",
		handler: async (_args, ctx) => {
			const text = formatMcpInventory(mcpInventory());
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
	pi.registerTool({
		name: "dev_doctor",
		label: "Environment Doctor",
		description:
			"Inspect Pi environment evidence. Static by default; installed/configured is not loaded, active, or ready. " +
			"Explicit probeImports executes trusted profile extension initializers (possible side effects); probeBrowser performs " +
			"authenticated loopback inventory only, NOT browser execution; probeDeps runs Node dependency resolution. " +
			"No repair, installs, profile changes, project commands, credential dumps, or model calls. Unknown states stay explicit. " +
			"Also lists current-runtime adapter-managed and extension-managed MCP integrations without connecting; /mcp lists only the former.",
		parameters: Type.Object({
			agentDir: Type.Optional(Type.String({ maxLength: 4096, description: "Profile directory; defaults to the current Pi profile" })),
			probeImports: Type.Optional(Type.Boolean({ description: "Opt in only after trusting all configured extension code" })),
			probeBrowser: Type.Optional(Type.Boolean({ description: "Opt in to authenticated browser-worker tools/list (no browser actions)" })),
			probeDeps: Type.Optional(Type.Boolean({ description: "Opt in to executing Node require.resolve for pi-shared dependencies" })),
			timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 60, description: "Deadline per checker, default 10 seconds" })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const seconds = params.timeoutSeconds ?? 10;
			if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("Invalid doctor deadline");
			const args = [DOCTOR, "--json", `--agent-dir=${params.agentDir ?? getAgentDir()}`, `--timeout=${seconds}`];
			if (params.probeImports) args.push("--probe-imports");
			if (params.probeBrowser) args.push("--probe-browser");
			if (params.probeDeps) args.push("--probe-deps");
			let output = "";
			let overflow = false;
			const process = await runManagedProcess({
				command: "python3", args, cwd: ROOT, env: { ...globalThis.process.env, PYTHONDONTWRITEBYTECODE: "1" }, signal,
				runTimeoutMs: Math.ceil(seconds * 3_000) + 5_000,
				termGraceMs: 1_500, maxStderrBytes: 1024, maxEventBytes: MAX_REPORT_BYTES,
				onStdoutChunk(chunk) {
					if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > MAX_REPORT_BYTES) overflow = true;
					else if (!overflow) output += chunk;
				},
			});
			if (process.terminationReason || overflow || ![0, 1].includes(process.exitCode)) {
				// Never echo child stderr, arguments, or arbitrary exception text.
				throw new Error(`Doctor report unavailable: ${process.terminationReason ?? (overflow ? "output_limit" : "process_failed")}`);
			}
			let report: any;
			try {
				report = JSON.parse(output);
				if (report.schema_version !== 1 || !Array.isArray(report.capabilities) ||
					!["inspection_complete", "issues_found"].includes(report.outcome)) throw new Error();
			} catch {
				throw new Error("Doctor returned an invalid or incomplete structured report");
			}
			const mcp = mcpInventory();
			return {
				content: [{ type: "text", text: `Pi doctor: ${report.outcome} (not a readiness verdict).\n` +
					report.capabilities.map((row: any) => `${row.capability}: ${row.outcome} [${row.probe_type}] — ${row.guidance}`).join("\n") +
					"\n\n" + formatMcpInventory(mcp) }],
				details: { ...report, checker_exit_code: process.exitCode, mcp_connections: mcp },
			};
		},
	});
}
