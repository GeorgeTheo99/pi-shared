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

function formatPlainPlan() {
	if (state.items.length === 0) return "No work plan.";
	return state.items.map((item) => itemLine(item, undefined, 160)).join("\n");
}

function setActive(id: number | undefined) {
	state.activeId = id;
	for (const item of state.items) {
		if (item.id === id) {
			item.status = "active";
			item.startedAt = item.startedAt ?? now();
			item.updatedAt = now();
		} else if (item.status === "active") {
			item.status = item.blockedBy.length ? "blocked" : "todo";
			item.updatedAt = now();
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
}

function setUi(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (state.items.length === 0) {
		ctx.ui.setWidget("work-plan", undefined);
		ctx.ui.setStatus("work-plan", undefined);
		return;
	}

	ctx.ui.setStatus("work-plan", planStatusSummary());
	ctx.ui.setWidget("work-plan", (_tui, theme) => ({
		invalidate() {},
		render(width: number) {
			const lines: string[] = [];
			const active = activeItem();
			const activeText = active
				? `✳ ${active.title}… (${formatDuration(now() - (active.startedAt ?? active.updatedAt))})`
				: "✳ Work plan";
			lines.push(truncateToWidth(theme.fg("accent", activeText), width));
			const items = state.items.slice(0, MAX_WIDGET_ITEMS);
			for (const item of items) lines.push(`  ${itemLine(item, theme, Math.max(0, width - 2))}`);
			if (state.items.length > MAX_WIDGET_ITEMS) {
				lines.push(truncateToWidth(theme.fg("dim", `  … ${state.items.length - MAX_WIDGET_ITEMS} more`), width));
			}
			return lines;
		},
	}));
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

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\nWork planning protocol:\n- For non-trivial implementation, refactor, debugging, or multi-step UI work, maintain a visible work plan with the work_plan tool.\n- Create or update the plan before doing substantial work; keep exactly one active item when possible.\n- Mark dependencies with blockedBy so blocked items render as \"blocked by #N\".\n- Update the plan as soon as a task becomes active, done, or blocked.\n- Do not use work_plan for tiny one-shot answers or trivial edits.`,
	}));

	pi.registerCommand("plan", {
		description: "Show or clear the current work plan. Usage: /plan [clear]",
		handler: async (args, ctx) => {
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
					setActive(firstActive?.id);
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
					if (item.status === "active") setActive(item.id);
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
					if (item.status === "active") setActive(item.id);
					else if (state.activeId === item.id && item.status !== "active") state.activeId = undefined;
					break;
				}
				case "activate": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for activate");
					setActive(item.id);
					break;
				}
				case "complete": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for complete");
					item.status = "done";
					item.completedAt = now();
					item.updatedAt = now();
					if (params.note !== undefined) item.note = params.note.trim() || undefined;
					if (state.activeId === item.id) state.activeId = undefined;
					const next = state.items.find((candidate) => candidate.status === "todo" && candidate.blockedBy.length === 0);
					if (next) setActive(next.id);
					break;
				}
				case "block": {
					const item = findItem(params.id);
					if (!item) return result(action, "valid id is required for block");
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
			const visible = expanded ? plan : plan.slice(0, 8);
			const lines = visible.map((item) => itemLine(item, theme, 160));
			if (!expanded && plan.length > visible.length) lines.push(theme.fg("dim", `… ${plan.length - visible.length} more`));
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
