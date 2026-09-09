import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { VerificationEngine } from "./engine.ts";

export default function verification(pi: ExtensionAPI) {
	const trusted = new Map<string, string>();
	let engine: VerificationEngine | undefined;
	const getEngine = () => engine ??= new VerificationEngine();
	pi.registerFlag("verification-trust", { description: "Explicitly trust this SHA256 of .pi/verification.json in the initial project (no automatic execution)", type: "string" });
	pi.on("session_start", async (_event, ctx) => {
		trusted.clear();
		const hash = pi.getFlag("verification-trust");
		if (typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) trusted.set(fs.realpathSync(ctx.cwd), hash);
	});
	pi.registerCommand("verification-trust", {
		description: "Review and approve the exact project verification configuration for this session",
		handler: async (_args, ctx) => {
			if (!ctx.isProjectTrusted()) throw new Error("Trust this Pi project before approving verification commands");
			if (!ctx.hasUI) throw new Error("Interactive trust needs UI; for headless use the explicit --verification-trust SHA256 startup flag after reviewing the file");
			const loaded = await loadConfig(ctx.cwd);
			if (await ctx.ui.confirm("Trust verification commands?", `Project: ${loaded.project}\nSHA256: ${loaded.sha256}\nCommands run with your full local permissions; this does not authorize destructive/external actions.\n\n${loaded.text}`)) {
				if ((await loadConfig(ctx.cwd)).sha256 !== loaded.sha256) throw new Error("Configuration changed during review; review again");
				trusted.set(loaded.project, loaded.sha256);
				ctx.ui.notify("Verification configuration trusted for this session", "info");
			}
		},
	});
	pi.registerTool({
		name: "verify", label: "Verification", executionMode: "sequential",
		description: "List/run/result for explicit .pi/verification.json checks. Run requires user-approved exact config digest, blocks on a managed command job, and returns a structured verdict with process, report, discovery, and source evidence. No inference from console prose. Result rechecks current source/config/report freshness. Never grants external/destructive authority. Limits: 64 KiB config, 2 MiB reports, 64 MiB input snapshot, latest 100 runtime-local results. Abort requests command cancellation.",
		parameters: Type.Object({
			action: Type.String({ enum: ["list", "run", "result"] }),
			check: Type.Optional(Type.String({ maxLength: 80 })),
			id: Type.Optional(Type.String({ maxLength: 80 })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
			const keys = params.action === "list" ? ["action"] : params.action === "run" ? ["action", "check"] : params.action === "result" ? ["action", "id"] : [];
			if (!keys.length || Object.keys(params).some(k => !keys.includes(k)) || (params.action === "run" && !params.check) || (params.action === "result" && !params.id)) throw new Error("Invalid verify action/fields");
			if (params.action === "list") {
				const details = await getEngine().list(ctx.cwd);
				return { content: [{ type: "text", text: `${details.checks.length} declared checks; config SHA256 ${details.configSha256}\n${details.checks.map(c => `${c.id}: ${c.format}`).join("\n")}` }], details };
			}
			if (params.action === "run" && !ctx.isProjectTrusted()) throw new Error("Trust this Pi project before running verification commands");
			const result = params.action === "run"
				? await getEngine().run(ctx.cwd, params.check!, trusted.get(fs.realpathSync(ctx.cwd)), signal, id => onUpdate?.({ content: [{ type: "text", text: `Verification running: ${id}` }], details: { version: 1, id, status: "running" } }))
				: await getEngine().result(ctx.cwd, params.id!);
			const counts = result.report?.counts;
			return { content: [{ type: "text", text: `${result.check.id}: ${result.verdict} (${result.id})\nProcess: ${result.process?.status ?? "unknown"}; source: ${result.source.status}${counts ? `; tests: ${counts.total}, failed: ${counts.failed}, skipped: ${counts.skipped}` : "; exit-code evidence only"}${result.reasons.length ? `\n${result.reasons.join("\n")}` : ""}` }], details: result };
		},
	});
	pi.on("session_shutdown", async () => { await engine?.close(); engine = undefined; trusted.clear(); });
}
