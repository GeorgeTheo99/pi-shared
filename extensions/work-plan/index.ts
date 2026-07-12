import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth } from "@mariozechner/pi-tui";

type PlanStatus = "todo" | "active" | "done" | "blocked";
type PlanAction = "set" | "add" | "update" | "activate" | "complete" | "block" | "unblock" | "clear" | "list";

type PlanItem = {
	id: number;
	title: string;
	status: PlanStatus;
	blockedBy: number[];
	note?: string;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	completedAt?: number;
	/**
	 * Total milliseconds the agent has actively spent on this item across all
	 * runs while it was the active task. Only accrues while the agent is
	 * streaming. Idle wall-clock time between turns does not count.
	 */
	activeMs?: number;
	/**
	 * Wall-clock timestamp when the current agent run started while this item
	 * was active. Set on agent_start when this item is the active task; cleared
	 * on agent_end (and the delta is folded into activeMs). Undefined when the
	 * agent is idle or when the item is not currently active.
	 */
	runStartedAt?: number;
};

type WorkPlanState = {
	version: 1;
	items: PlanItem[];
	nextId: number;
	activeId?: number;
	createdAt: number;
	updatedAt: number;
};

type WorkPlanDetails = {
	action: PlanAction;
	state: WorkPlanState;
	error?: string;
};

const CUSTOM_TYPE = "pi-work-plan-state";
const MAX_ITEMS = 40;
const MAX_WIDGET_ITEMS = 12;
const BLOCKED_ARROW = " › blocked by ";
// When more than KEEP_RECENT_DONE done items exist, the oldest ones are
// collapsed into a single summary line for rendering. State is preserved in
// full — this is purely a visual / prompt-budget condense, not a prune.
const KEEP_RECENT_DONE = 3;

let state: WorkPlanState = emptyState();

function now() {
	return Date.now();
}

function emptyState(): WorkPlanState {
	const timestamp = now();
	return { version: 1, items: [], nextId: 1, createdAt: timestamp, updatedAt: timestamp };
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTitle(title: string | undefined) {
	return title?.trim().replace(/\s+/g, " ") ?? "";
}

function normalizeBlockedBy(values: number[] | undefined) {
	return [...new Set((values ?? []).filter((value) => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

function findItem(id: number | undefined) {
	if (id === undefined) return undefined;
	return state.items.find((item) => item.id === id);
}

function activeItem() {
	return state.activeId === undefined ? undefined : findItem(state.activeId);
}

function effectiveActiveMs(item: PlanItem) {
	const base = item.activeMs ?? 0;
	if (item.runStartedAt) return base + Math.max(0, now() - item.runStartedAt);
	return base;
}

function iconFor(status: PlanStatus, isActive: boolean) {
	if (status === "done") return "✔";
	if (status === "blocked") return "◻";
	if (isActive || status === "active") return "◼";
	return "◻";
}

function formatDuration(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours) return `${hours}h ${minutes}m`;
	if (minutes) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function itemLine(item: PlanItem, theme: Theme | undefined, width: number) {
	const isActive = state.activeId === item.id || item.status === "active";
	const icon = iconFor(item.status, isActive);
	const blocked = item.blockedBy.length ? `${BLOCKED_ARROW}${item.blockedBy.map((id) => `#${id}`).join(", ")}` : "";
	const note = item.note ? ` — ${item.note}` : "";
	const raw = `${icon} ${item.title}${blocked}${note}`;
	if (!theme) return truncateToWidth(raw, width);
	const color = item.status === "done" ? "success" : item.status === "blocked" ? "warning" : isActive ? "accent" : "text";
	const mutedTail = blocked || note ? theme.fg("dim", `${blocked}${note}`) : "";
	const title = theme.fg(color, `${icon} ${item.title}`);
	return truncateToWidth(`${title}${mutedTail}`, width);
}

/**
 * Returns a render plan that condenses older done items into a single
 * summary entry once their count exceeds KEEP_RECENT_DONE. The original
 * insertion order is preserved; the summary is inserted at the position of
 * the first hidden done item so the checklist still reads chronologically.
 * State.items is never mutated by this helper.
 */
type RenderEntry = { kind: "item"; item: PlanItem } | { kind: "summary"; count: number };

function renderEntries(items: PlanItem[] = state.items): RenderEntry[] {
	const doneItems = items.filter((item) => item.status === "done");
	if (doneItems.length <= KEEP_RECENT_DONE + 1) {
		return items.map((item) => ({ kind: "item", item }));
	}
	const keepIds = new Set(doneItems.slice(-KEEP_RECENT_DONE).map((item) => item.id));
	const hiddenCount = doneItems.length - KEEP_RECENT_DONE;
	const entries: RenderEntry[] = [];
	let summaryEmitted = false;
	for (const item of items) {
		if (item.status === "done" && !keepIds.has(item.id)) {
			if (!summaryEmitted) {
				entries.push({ kind: "summary", count: hiddenCount });
				summaryEmitted = true;
			}
			continue;
		}
		entries.push({ kind: "item", item });
	}
	return entries;
}

function summaryLine(count: number, theme: Theme | undefined, width: number) {
	const raw = `✔ ${count} earlier tasks done`;
	if (!theme) return truncateToWidth(raw, width);
	return truncateToWidth(theme.fg("dim", raw), width);
}

function renderLines(theme: Theme | undefined, width: number, items?: PlanItem[]) {
	return renderEntries(items).map((entry) =>
		entry.kind === "summary" ? summaryLine(entry.count, theme, width) : itemLine(entry.item, theme, width),
	);
}

function formatPlainPlan() {
	if (state.items.length === 0) return "No work plan.";
	return renderLines(undefined, 160).join("\n");
}

function flushRun(item: PlanItem) {
	if (item.runStartedAt) {
		item.activeMs = (item.activeMs ?? 0) + Math.max(0, now() - item.runStartedAt);
		item.runStartedAt = undefined;
	}
}

function setActive(id: number | undefined, options?: { agentStreaming?: boolean }) {
	const timestamp = now();
	state.activeId = id;
	for (const item of state.items) {
		if (item.id === id) {
			item.status = "active";
			item.startedAt = item.startedAt ?? timestamp;
			item.updatedAt = timestamp;
			// Start charging time immediately if the agent is currently working.
			if (options?.agentStreaming && !item.runStartedAt) item.runStartedAt = timestamp;
		} else if (item.status === "active") {
			flushRun(item);
			item.status = item.blockedBy.length ? "blocked" : "todo";
			item.updatedAt = timestamp;
		} else if (item.runStartedAt) {
			// Defensive: stale runStartedAt on a non-active item.
			flushRun(item);
		}
	}
}

function save(pi: ExtensionAPI) {
	state.updatedAt = now();
	pi.appendEntry(CUSTOM_TYPE, clone(state));
}

function restore(ctx: ExtensionContext) {
	state = emptyState();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
		state = clone(entry.data as WorkPlanState) ?? emptyState();
	}
	// Restored state may carry a stale runStartedAt from a previous Pi process
	// that was killed mid-stream. Don't credit that wall-clock time — fold any
	// pending in-flight delta into activeMs only if we genuinely know about it,
	// otherwise just reset so the timer doesn't spike on /reload.
	for (const item of state.items) {
		if (item.runStartedAt) item.runStartedAt = undefined;
	}
}

function setUi(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (state.items.length === 0) {
		ctx.ui.setWidget("work-plan", undefined);
		ctx.ui.setStatus("work-plan", undefined);
		return;
	}

	ctx.ui.setStatus("work-plan", planStatusSummary());
	ctx.ui.setWidget("work-plan", (tui, theme) => {
		// Self-tick once per second so the active-item timer animates while the
		// agent is streaming. We only request a render when the timer is
		// actively charging (active item with runStartedAt set); otherwise the
		// displayed value is frozen on accumulatedActiveMs and there's nothing
		// to redraw, so we stay quiet and don't waste TUI render cycles.
		const tickHandle = setInterval(() => {
			const active = activeItem();
			if (active?.runStartedAt) tui.requestRender();
		}, 1000);
		return {
			invalidate() {},
			render(width: number) {
				const lines: string[] = [];
				const active = activeItem();
				const activeText = active
					? `✳ ${active.title}… (${formatDuration(effectiveActiveMs(active))})`
					: "✳ Work plan";
				lines.push(truncateToWidth(theme.fg("accent", activeText), width));
				const entries = renderEntries();
				const visible = entries.slice(0, MAX_WIDGET_ITEMS);
				const innerWidth = Math.max(0, width - 2);
				for (const entry of visible) {
					const body = entry.kind === "summary" ? summaryLine(entry.count, theme, innerWidth) : itemLine(entry.item, theme, innerWidth);
					lines.push(`  ${body}`);
				}
				if (entries.length > MAX_WIDGET_ITEMS) {
					lines.push(truncateToWidth(theme.fg("dim", `  … ${entries.length - MAX_WIDGET_ITEMS} more`), width));
				}
				return lines;
			},
			dispose() {
				clearInterval(tickHandle);
			},
		};
	});
}

function planStatusSummary() {
	const done = state.items.filter((item) => item.status === "done").length;
	const blocked = state.items.filter((item) => item.status === "blocked").length;
	const total = state.items.length;
	const active = activeItem();
	const suffix = active ? ` #${active.id}` : blocked ? ` ${blocked} blocked` : "";
	return `plan ${done}/${total}${suffix}`;
}

function result(action: PlanAction, error?: string) {
	const body = error ? `Error: ${error}` : formatPlainPlan();
	return {
		content: [{ type: "text" as const, text: body }],
		details: { action, state: clone(state), error } satisfies WorkPlanDetails,
	};
}

const PlanItemInput = Type.Object({
	title: Type.String({ description: "Short task title" }),
	status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("active"), Type.Literal("done"), Type.Literal("blocked")])),
	blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids this item is blocked by" })),
	note: Type.Optional(Type.String({ description: "Short status note" })),
});

export default function workPlanExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		setUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		setUi(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// Stock Pi may apply newSession.setup() after the replacement extension's
		// initial session_start. Re-read transferred state before the first prompt.
		restore(ctx);
		setUi(ctx);
		return {
			systemPrompt: `${event.systemPrompt}\n\nWork planning protocol:\n- For non-trivial implementation, refactor, debugging, or multi-step UI work, maintain a visible work plan with the work_plan tool.\n- Create or update the plan before doing substantial work; keep exactly one active item when possible.\n- Mark dependencies with blockedBy so blocked items render as \"blocked by #N\".\n- Update the plan as soon as a task becomes active, done, or blocked.\n- Older done items are condensed automatically into a single \"✔ N earlier tasks done\" line; full state is preserved on disk, so you do not need to delete or rewrite finished items to keep the plan readable.\n- Do not use work_plan for tiny one-shot answers or trivial edits.`,
		};
	});

	// Pause the active-item timer when the agent is idle. The widget timer
	// represents agent work spent on the active task, not wall-clock time since
	// the task was first activated.
	pi.on("agent_start", async (_event, ctx) => {
		const active = activeItem();
		if (active && !active.runStartedAt) {
			active.runStartedAt = now();
			setUi(ctx);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		let changed = false;
		for (const item of state.items) {
			if (item.runStartedAt) {
				flushRun(item);
				changed = true;
			}
		}
		if (changed) {
			// Persist the flushed accumulator so a /reload or session restore picks
			// up the correct elapsed-on-task value instead of resetting to zero.
			save(pi);
			setUi(ctx);
		}
	});

	pi.registerCommand("plan", {
		description: "Show or clear the current work plan. Usage: /plan [clear]",
		handler: async (args, ctx) => {
			restore(ctx);
			setUi(ctx);
			const verb = args.trim().toLowerCase();
			if (verb === "clear") {
				state = emptyState();
				save(pi);
				setUi(ctx);
				ctx.ui.notify("Work plan cleared.", "info");
				return;
			}
			pi.sendMessage({ customType: "work-plan", content: formatPlainPlan(), display: true, details: clone(state) });
		},
	});

	pi.registerTool({
		name: "work_plan",
		label: "Work Plan",
		description:
			"Create and maintain a visible implementation checklist with active, done, and blocked tasks. Use for non-trivial multi-step work; do not use for tiny one-shot tasks.",
		promptSnippet: "Track a visible work plan/checklist with active, done, and blocked tasks.",
		promptGuidelines: [
			"For non-trivial implementation, refactor, debugging, or UI work, create a work_plan before substantial work.",
			"Keep exactly one active task when possible and update it as work progresses.",
			"Use blockedBy to show dependencies, e.g. item #7 blocked by #2 and #4.",
			"Mark tasks done only after concrete verification for that task.",
			"Do not use work_plan for tiny one-shot answers or trivial edits.",
		],
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("set"),
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("activate"),
				Type.Literal("complete"),
				Type.Literal("block"),
				Type.Literal("unblock"),
				Type.Literal("clear"),
				Type.Literal("list"),
			], { description: "Plan action" }),
			items: Type.Optional(Type.Array(PlanItemInput, { description: "Items for action=set" })),
			id: Type.Optional(Type.Number({ description: "Task id for update/activate/complete/block/unblock" })),
			title: Type.Optional(Type.String({ description: "Task title for add/update" })),
			status: Type.Optional(Type.Union([Type.Literal("todo"), Type.Literal("active"), Type.Literal("done"), Type.Literal("blocked")])),
			blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Task ids this item is blocked by" })),
			note: Type.Optional(Type.String({ description: "Short status note" })),
		}),

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const action = params.action as PlanAction;

			switch (action) {
				case "set": {
					const items = (params.items ?? []).slice(0, MAX_ITEMS);
					state = emptyState();
					for (const item of items) {
						const title = normalizeTitle(item.title);
						if (!title) continue;
						const id = state.nextId++;
						const timestamp = now();
						const blockedBy = normalizeBlockedBy(item.blockedBy);
						state.items.push({
							id,
							title,
							status: item.status ?? (blockedBy.length ? "blocked" : "todo"),
							blockedBy,
							note: item.note?.trim() || undefined,
							createdAt: timestamp,
							updatedAt: timestamp,
							startedAt: item.status === "active" ? timestamp : undefined,
							completedAt: item.status === "done" ? timestamp : undefined,
						});
					}
					const firstActive = state.items.find((item) => item.status === "active") ?? state.items.find((item) => item.status !== "done" && item.status !== "blocked");
					setActive(firstActive?.id, { agentStreaming: !ctx.isIdle() });
					break;
				}
				case "add": {
					if (state.items.length >= MAX_ITEMS) return result(action, `maximum of ${MAX_ITEMS} items reached`);
					const title = normalizeTitle(params.title);
					if (!title) return result(action, "title is required for add");
					const timestamp = now();
					const blockedBy = normalizeBlockedBy(params.blockedBy);
					const item: PlanItem = {
						id: state.nextId++,
						title,
						status: (params.status as PlanStatus | undefined) ?? (blockedBy.length ? "blocked" : "todo"),
						blockedBy,
						note: params.note?.trim() || undefined,
						createdAt: timestamp,
						updatedAt: timestamp,
					};
					state.items.push(item);
					if (item.status === "active") setActive(item.id, { agentStreaming: !ctx.isIdle() });
					break;
				}
				case "update": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for update");
					const title = normalizeTitle(params.title);
					if (title) item.title = title;
					if (params.blockedBy) {
						item.blockedBy = normalizeBlockedBy(params.blockedBy);
						if (!params.status && item.status !== "done" && item.status !== "active") {
							item.status = item.blockedBy.length ? "blocked" : "todo";
						}
					}
					if (params.note !== undefined) item.note = params.note.trim() || undefined;
					if (params.status) item.status = params.status as PlanStatus;
					item.updatedAt = now();
					if (item.status === "active") setActive(item.id, { agentStreaming: !ctx.isIdle() });
					else if (state.activeId === item.id && item.status !== "active") {
						flushRun(item);
						state.activeId = undefined;
					}
					break;
				}
				case "activate": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for activate");
					setActive(item.id, { agentStreaming: !ctx.isIdle() });
					break;
				}
				case "complete": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for complete");
					flushRun(item);
					item.status = "done";
					item.completedAt = now();
					item.updatedAt = now();
					if (params.note !== undefined) item.note = params.note.trim() || undefined;
					if (state.activeId === item.id) state.activeId = undefined;
					const next = state.items.find((candidate) => candidate.status === "todo" && candidate.blockedBy.length === 0);
					if (next) setActive(next.id, { agentStreaming: !ctx.isIdle() });
					break;
				}
				case "block": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for block");
					flushRun(item);
					item.status = "blocked";
					item.blockedBy = normalizeBlockedBy(params.blockedBy);
					if (params.note !== undefined) item.note = params.note.trim() || undefined;
					item.updatedAt = now();
					if (state.activeId === item.id) state.activeId = undefined;
					break;
				}
				case "unblock": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for unblock");
					item.status = "todo";
					item.blockedBy = [];
					if (params.note !== undefined) item.note = params.note.trim() || undefined;
					item.updatedAt = now();
					break;
				}
				case "clear":
					state = emptyState();
					break;
				case "list":
					setUi(ctx);
					return result(action);
			}

			save(pi);
			setUi(ctx);
			return result(action);
		},

		renderCall(args, theme) {
			const bits = [theme.fg("toolTitle", theme.bold("work_plan ")), theme.fg("muted", args.action ?? "")];
			if (args.id !== undefined) bits.push(theme.fg("accent", ` #${args.id}`));
			if (args.title) bits.push(theme.fg("dim", ` ${args.title}`));
			return new Text(bits.join(""), 0, 0);
		},

		renderResult(toolResult, { expanded }, theme) {
			const details = toolResult.details as WorkPlanDetails | undefined;
			if (!details) {
				const first = toolResult.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
			const plan = details.state.items;
			if (plan.length === 0) return new Text(theme.fg("dim", "No work plan"), 0, 0);
			// Expanded view always shows every item; collapsed view condenses older
			// done items just like the widget and tool-result text body.
			const lines = expanded
				? plan.map((item) => itemLine(item, theme, 160))
				: renderLines(theme, 160, plan).slice(0, 8);
			const totalEntries = expanded ? plan.length : renderEntries(plan).length;
			if (!expanded && totalEntries > lines.length) lines.push(theme.fg("dim", `… ${totalEntries - lines.length} more`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
