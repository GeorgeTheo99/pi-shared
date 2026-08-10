import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const MAX_OPTIONS = 12;
const CUSTOM_OPTION_BASE_LABEL = "✎ Type something else";

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	cancelled: boolean;
	wasCustom: boolean;
	selectedIndex?: number;
	error?: string;
}

function normalizeOptions(options: string[] | undefined): string[] {
	return [...new Set((options ?? []).map((option) => option.trim()).filter(Boolean))].slice(0, MAX_OPTIONS);
}

function customOptionLabel(existing: Set<string>): string {
	let label = CUSTOM_OPTION_BASE_LABEL;
	while (existing.has(label)) label += "…";
	return label;
}

function textResult(text: string, details: AskUserDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function dialogOptions(timeoutMs: number | undefined, signal: AbortSignal | undefined) {
	return {
		signal,
		...(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
			? { timeout: timeoutMs }
			: {}),
	};
}

const askUserTool = defineTool({
	name: "ask_user",
	label: "Ask User",
	description:
		"Ask the user an interactive multiple-choice question and return their answer. Use only when progress is blocked by a necessary user decision, preference, missing fact, or approval. If the user declines, dismisses, or times out the prompt, the agent loop is aborted and control is returned to the user — the agent must wait for the user's next message and must NEVER assume an answer or continue the prior task.",
	promptSnippet: "ask_user to ask the user a structured question with selectable options",
	promptGuidelines: [
		"Use ask_user when you genuinely need a user decision to proceed and the choices can be made explicit.",
		"Use ask_user for opinionated topics, product/design decisions, irreversible tradeoffs, or when you are genuinely unsure.",
		"Do not use ask_user for routine status updates, rhetorical questions, or information you can safely discover with available tools.",
		"Provide concise, mutually exclusive options. Include a safe/cancel/no-op option when relevant.",
		"If the user dismisses or times out an ask_user prompt, the agent loop is aborted automatically. Do not assume a default answer, do not pick an option on the user's behalf, and do not continue the prior task. Wait for the user's next message before doing anything.",
		"ALWAYS invoke ask_user via the native tool-call channel. NEVER emit `<ask_user>`, `<question>`, `<options>`, `<allow_custom>`, or any other XML/HTML-style tag in assistant text to represent a question — that syntax is from a different harness and will render as raw markup to the user instead of opening an interactive prompt. If you want to ask the user, call the ask_user tool; otherwise just write the question as plain prose.",
	],
	parameters: Type.Object({
		question: Type.String({ description: "The question to show the user" }),
		options: Type.Optional(
			Type.Array(Type.String(), {
				description: `Selectable answer options. Up to ${MAX_OPTIONS} non-empty unique options are shown.`,
			}),
		),
		allow_custom: Type.Optional(
			Type.Boolean({
				description: "Allow the user to type a custom answer instead of selecting one of the options. Defaults to false when options are supplied, true when no options are supplied.",
			}),
		),
		custom_prompt: Type.Optional(
			Type.String({ description: "Prompt to show when collecting a custom answer" }),
		),
		timeout_ms: Type.Optional(
			Type.Number({ description: "Optional timeout in milliseconds. Timeout is treated as cancellation." }),
		),
	}),
	executionMode: "sequential",

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const question = params.question.trim();
		const options = normalizeOptions(params.options);
		const allowCustom = params.allow_custom ?? options.length === 0;
		const baseDetails: AskUserDetails = {
			question,
			options,
			answer: null,
			cancelled: false,
			wasCustom: false,
		};

		// Build a tool result that returns control to the user when they decline,
		// dismiss, or time out the prompt. ctx.abort() halts the agent loop so the
		// model cannot continue assuming an answer.
		const cancelledResult = (details: AskUserDetails) => {
			try {
				ctx.abort();
			} catch {
				// ctx.abort() should always be safe inside a running tool, but ignore any
				// runner-side error so we still return a well-formed tool result.
			}
			return textResult(
				"User did not answer the question (declined, dismissed, or timed out). The agent loop has been aborted and control is returned to the user. Do NOT assume an answer, do NOT pick a default, and do NOT continue the prior task. Wait for the user's next message before taking any further action.",
				details,
			);
		};

		if (!question) {
			return textResult("Error: question is required", {
				...baseDetails,
				error: "question is required",
			});
		}

		if (!ctx.hasUI) {
			return textResult("Error: interactive UI is not available; ask the user directly in chat instead.", {
				...baseDetails,
				error: "interactive UI is not available",
			});
		}

		if (options.length === 0 && !allowCustom) {
			return textResult("Error: at least one option is required when custom answers are disabled", {
				...baseDetails,
				error: "no options provided",
			});
		}

		if (options.length === 0) {
			const answer = await ctx.ui.input(
				params.custom_prompt?.trim() || question,
				"Type your answer",
				dialogOptions(params.timeout_ms, signal),
			);
			const trimmed = answer?.trim();
			if (!trimmed) {
				return cancelledResult({ ...baseDetails, cancelled: true, wasCustom: true });
			}
			return textResult(`User answered: ${trimmed}`, {
				...baseDetails,
				answer: trimmed,
				wasCustom: true,
			});
		}

		const existing = new Set(options);
		const customLabel = customOptionLabel(existing);
		const displayedOptions = allowCustom ? [...options, customLabel] : options;
		const selected = await ctx.ui.select(question, displayedOptions, dialogOptions(params.timeout_ms, signal));

		if (!selected) {
			return cancelledResult({ ...baseDetails, cancelled: true });
		}

		if (selected === customLabel) {
			const answer = await ctx.ui.input(
				params.custom_prompt?.trim() || question,
				"Type your answer",
				dialogOptions(params.timeout_ms, signal),
			);
			const trimmed = answer?.trim();
			if (!trimmed) {
				return cancelledResult({ ...baseDetails, cancelled: true, wasCustom: true });
			}
			return textResult(`User answered: ${trimmed}`, {
				...baseDetails,
				answer: trimmed,
				wasCustom: true,
			});
		}

		const selectedIndex = options.indexOf(selected) + 1;
		return textResult(`User selected: ${selectedIndex}. ${selected}`, {
			...baseDetails,
			answer: selected,
			selectedIndex,
		});
	},

	renderCall(args, theme) {
		const options = normalizeOptions(args.options);
		const lines = [theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question ?? "")];
		if (options.length) {
			lines.push(theme.fg("dim", `  Options: ${options.map((option, index) => `${index + 1}. ${option}`).join(", ")}`));
		}
		if (args.allow_custom) lines.push(theme.fg("dim", "  Custom answer allowed"));
		return new Text(lines.join("\n"), 0, 0);
	},

	renderResult(result, _options, theme) {
		const details = result.details as AskUserDetails | undefined;
		if (!details) {
			const first = result.content[0];
			return new Text(first?.type === "text" ? first.text : "", 0, 0);
		}
		if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
		if (details.cancelled || details.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
		if (details.wasCustom) return new Text(theme.fg("success", "✓ ") + theme.fg("accent", details.answer), 0, 0);
		const prefix = details.selectedIndex ? `${details.selectedIndex}. ` : "";
		return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `${prefix}${details.answer}`), 0, 0);
	},
});

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool(askUserTool);
}
