/** Read-only discovery. Capability groups do not participate in activation. */
const groups = [
	{ name: "development", description: "Managed commands, verification, code intelligence and environment diagnostics", tools: ["command_job", "verify", "code_intel", "dev_doctor"] },
	{ name: "browser", description: "Public browser retrieval and local/private app testing (independent boundaries)", tools: ["browser_fetch", "browser_inspect", "app_*"] },
	{ name: "delegation", description: "Subagent delegation, model panels and bounded waiting", tools: ["spawn_subagent", "panel_select", "wait_for"] },
	{ name: "planning", description: "Work plans, goals, user questions and project memory", tools: ["work_plan", "start_goal", "update_goal", "ask_user", "memory_*"] },
	{ name: "recall", description: "Recall original tool results and search the web", tools: ["tool_result_recall", "web_search", "web_fetch"] },
];
interface Row { kind: "bundle" | "group" | "tool"; name: string; description: string; groups?: string[]; active?: boolean; eligible?: boolean; loaded?: boolean; available?: boolean; toolCount?: number; fieldsTruncated?: boolean }
interface Input {
	tools: { name: string; description: string }[];
	bundles: { name: string; description: string; tools: string[]; loaded: boolean; available: boolean }[];
	active: Set<string>;
	eligible: Set<string>;
	query?: string;
	group?: string;
	limit?: number;
	offset?: number;
}
export function searchCatalog(input: Input) {
	const { query = "", group, limit = 20, offset = 0 } = input;
	if (query.length > 200 || (group?.length ?? 0) > 200) throw new Error("Search query/group must be at most 200 characters.");
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be an integer from 1 to 50.");
	if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error("offset must be an integer from 0 to 10000.");
	const catalogGroups = groups.map(g => ({ ...g, tools: input.tools.filter(t => g.tools.some(p => p.endsWith("*") ? t.name.startsWith(p.slice(0, -1)) : t.name === p)).map(t => t.name) })).filter(g => g.tools.length);
	const rows: Row[] = [
		...input.bundles.map(b => ({ kind: "bundle" as const, name: b.name, description: b.description, groups: [b.name], loaded: b.loaded, available: b.available, toolCount: b.tools.length })),
		...catalogGroups.map(g => ({ kind: "group" as const, name: g.name, description: g.description, groups: [g.name], toolCount: g.tools.length })),
		...[...new Map(input.tools.map(t => [t.name, t])).values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => ({
			kind: "tool" as const, name: t.name, description: t.description,
			groups: [...new Set([...input.bundles, ...catalogGroups].filter(g => g.tools.includes(t.name)).map(g => g.name))],
			active: input.active.has(t.name), eligible: input.eligible.has(t.name),
		})),
	];
	const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
	const matches = rows.filter(r => (!group || r.groups?.includes(group)) && terms.every(term => `${r.name} ${r.description} ${r.groups?.join(" ")}`.toLowerCase().includes(term)));
	const results: Row[] = [];
	let bytes = 0;
	for (const r of matches.slice(offset, offset + limit)) {
		const row = { ...r, description: r.description.slice(0, 300), groups: r.groups?.slice(0, 20),
			fieldsTruncated: r.description.length > 300 || (r.groups?.length ?? 0) > 20 };
		const size = Buffer.byteLength(JSON.stringify(row));
		// Preserve exact identifiers; refuse oversized rows rather than invent truncated names.
		if (bytes + size > 16000) break;
		results.push(row); bytes += size;
	}
	const next = offset + results.length;
	return { schemaVersion: 1, query, group: group ?? null, total: matches.length, returned: results.length, truncated: next < matches.length,
		nextOffset: results.length && next < matches.length && next <= 10000 ? next : null, fieldsBounded: true, results };
}
