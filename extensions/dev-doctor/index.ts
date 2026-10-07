import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runManagedProcess } from "../_shared/managed-process.ts";
import { createMcpInventory, formatMcpInventory } from "./mcp-inventory.ts";
import { structuredTool } from "../_shared/structured-result.ts";

const DoctorData = Type.Object({
	outcome: Type.String(), checker_exit_code: Type.Integer(),
	capabilities: Type.Array(Type.Object({
		capability: Type.String(), outcome: Type.String(), probe_type: Type.String(), guidance: Type.String(),
		installed: Type.Optional(Type.String()), loaded: Type.Optional(Type.String()),
		active: Type.Optional(Type.String()), configured: Type.Optional(Type.String()),
	})),
	mcp_connections: Type.Object({
		schema_version: Type.Integer(), scope: Type.String(),
		native: Type.Object({ evidence: Type.String(), total: Type.Integer(), truncated: Type.Boolean(),
			servers: Type.Array(Type.Object({ name: Type.String(), registered_tool_count: Type.Integer(), active_tool_count: Type.Integer() })),
			service_readiness: Type.String() }),
		adapter: Type.Object({ evidence: Type.String(), observed_at: Type.Optional(Type.String()), total: Type.Optional(Type.Integer()),
			truncated: Type.Optional(Type.Boolean()), servers: Type.Optional(Type.Array(Type.Object({ name: Type.String(), status: Type.String(), tool_count: Type.Integer() }))) }),
		extension_managed: Type.Array(Type.Object({ name: Type.String(), registered_tools: Type.Array(Type.String()), active_tools: Type.Array(Type.String()), service_readiness: Type.String() })),
	}),
});

const DOCTOR = fileURLToPath(new URL("../../bin/pi-doctor", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MAX_REPORT_BYTES = 32 * 1024;

export default function (pi: ExtensionAPI) {
	const mcpInventory = createMcpInventory(pi);
	pi.registerTool(structuredTool(defineTool({
		name: "dev_doctor",
		label: "Environment Doctor",
		description:
			"Inspect Pi environment evidence. Static by default; installed/configured is not loaded, active, or ready. " +
			"Explicit probeImports executes trusted profile extension initializers (possible side effects); probeBrowser performs " +
			"authenticated loopback inventory only, NOT browser execution; probeDeps runs Node dependency resolution. " +
			"No repair, installs, profile changes, project commands, credential dumps, or model calls. Unknown states stay explicit. " +
			"Also lists registered official MCP tools, legacy adapter reports and extension-managed integrations without connecting; use /mcp for server connection status.",
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
	}), DoctorData, result => ({ data: result.details, status: result.details.outcome === "issues_found" ? "error" : "ok" })));
}
