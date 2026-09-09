import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Public, notification-only adapter contract. No adapter dependency or server calls.
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";
const MAX_SERVERS = 50;
const STATUSES = new Set(["connected", "cached", "failed", "needs-auth", "not-connected", "disabled"]);
const wrappers = [
	{ name: "browser-worker", path: "../pi-browser-capture/src/browser-worker.ts", tools: ["browser_fetch", "browser_inspect"] },
	{ name: "local-search", path: "../websearch/index.ts", tools: ["web_search", "web_fetch"] },
	{ name: "deep-research (uses local-search)", path: "../deep-research/index.ts", tools: ["deep_research"] },
];
interface Server { name: string; status: string; tool_count: number }
interface AdapterSnapshot { observed_at: string; total: number; truncated: boolean; servers: Server[] }

function canonical(path: string | undefined): string | undefined {
	try { return path ? realpathSync(path) : undefined; } catch { return undefined; }
}

export function createMcpInventory(pi: ExtensionAPI) {
	let adapter: AdapterSnapshot | undefined;
	let adapterEvidence = "not_observed";
	const unsubscribe = pi.events.on(MCP_STATUS_EVENT, (data: unknown) => {
		// Drop any previous snapshot on malformed updates; never retain arbitrary payloads.
		adapter = undefined;
		adapterEvidence = "invalid_report";
		if (!data || typeof data !== "object") return;
		const value = data as { version?: unknown; servers?: unknown };
		if (value.version !== 1 || !Array.isArray(value.servers)) return;
		const servers: Server[] = [];
		for (const item of value.servers.slice(0, MAX_SERVERS)) {
			if (!item || typeof item !== "object" || typeof item.name !== "string" ||
				!/^[-a-zA-Z0-9_.:]{1,128}$/.test(item.name) || !STATUSES.has(item.status) ||
				!Number.isSafeInteger(item.toolCount) || item.toolCount < 0) return;
			servers.push({ name: item.name, status: item.status, tool_count: item.toolCount });
		}
		adapter = { observed_at: new Date().toISOString(), total: value.servers.length,
			truncated: value.servers.length > MAX_SERVERS, servers };
		adapterEvidence = "adapter_reported";
	});
	pi.on("session_shutdown", () => {
		unsubscribe();
		adapter = undefined;
		adapterEvidence = "not_observed";
	});

	return () => {
		const tools = pi.getAllTools();
		const active = new Set(pi.getActiveTools());
		return {
			schema_version: 1,
			scope: "current Pi runtime only, independent of doctor agentDir; registration and adapter reports are not service readiness",
			adapter: { evidence: adapterEvidence, ...(adapter ? structuredClone(adapter) : {}) },
			extension_managed: wrappers.map(wrapper => {
				const expectedPath = canonical(fileURLToPath(new URL(wrapper.path, import.meta.url)));
				const registered = tools.filter(tool => wrapper.tools.includes(tool.name) && expectedPath !== undefined &&
					canonical(tool.sourceInfo?.path) === expectedPath).map(tool => tool.name);
				return { name: wrapper.name, registered_tools: registered,
					active_tools: registered.filter(name => active.has(name)),
					service_readiness: "not_probed" };
			}),
		};
	};
}

export function formatMcpInventory(report: ReturnType<ReturnType<typeof createMcpInventory>>): string {
	const lines = ["MCP connections — current Pi runtime (no connections or service probes performed)",
		"Adapter-managed (/mcp):"];
	if (report.adapter.evidence !== "adapter_reported") {
		lines.push(`  ${report.adapter.evidence}: no usable adapter snapshot; adapter may be absent or not initialized.`);
	} else {
		lines.push(`  Last adapter report: ${report.adapter.observed_at}`);
		for (const server of report.adapter.servers ?? []) {
			lines.push(`  ${server.name}: ${server.status}, ${server.tool_count} tools`);
		}
		if (!report.adapter.total) lines.push("  No servers in the last adapter report.");
		if (report.adapter.truncated) lines.push(`  Showing first ${MAX_SERVERS} of ${report.adapter.total} servers; use /mcp for the full inventory.`);
	}
	lines.push("Extension-managed (not listed in /mcp):");
	for (const row of report.extension_managed) {
		lines.push(`  ${row.name}: ${row.registered_tools.length ? row.registered_tools.join(", ") : "no tools registered by this wrapper"}; ${row.active_tools.length} active; service not probed`);
	}
	lines.push("Registered/active tools and cached/connected metadata do not prove backend health. Missing wrapper tools may be disabled, unloaded, or unavailable.",
		"For explicit checks: pi-browser-check verifies browser inventory only; local-search verify checks the search service. app_* tools are in-process, not MCP.");
	return lines.join("\n");
}
