/**
 * Footer that keeps the model visible in narrow terminals.
 *
 * Pi's built-in footer puts the model to the right of the token stats and, when
 * both don't fit, truncates the model, so a phone-width terminal shows only its
 * first letter. This footer renders the same content and moves the model to its
 * own line instead. Remove it once Pi's built-in footer does that itself.
 *
 * Mirrors Pi 1.5's FooterComponent except for routed virtual models, whose
 * routing extensions can't observe.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MIN_PADDING = 2;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const isInsideHome = relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * The stats line, with the model on it when both fit (provider first when there is
 * room), else the stats and a right-aligned model line.
 */
export function layoutStats(
	statsLeft: string,
	model: string,
	modelWithProvider: string | undefined,
	width: number,
): { stats: string; model: string; wrapped: boolean } {
	const stats = visibleWidth(statsLeft) > width ? truncateToWidth(statsLeft, width, "...") : statsLeft;
	const statsWidth = visibleWidth(stats);
	for (const candidate of [modelWithProvider, model]) {
		if (candidate === undefined) continue;
		const candidateWidth = visibleWidth(candidate);
		if (statsWidth + MIN_PADDING + candidateWidth <= width) {
			return { stats, model: " ".repeat(width - statsWidth - candidateWidth) + candidate, wrapped: false };
		}
	}
	const own = modelWithProvider !== undefined && visibleWidth(modelWithProvider) <= width ? modelWithProvider : model;
	const line = truncateToWidth(own, width, "");
	return { stats, model: " ".repeat(Math.max(0, width - visibleWidth(line))) + line, wrapped: true };
}

interface SessionStats {
	sessionId: string;
	leafId: string | null;
	model: ExtensionContext["model"];
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate: number | undefined;
	contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
}

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

function isUsingSubscription(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	// Kimi Coding is subscription-backed despite using API-key authentication.
	if (model.provider === "kimi-coding") return true;
	return ctx.modelRegistry.isUsingOAuth(model) && ctx.modelRegistry.getProvider(model.provider)?.auth?.oauth?.isSubscription === true;
}

export default function footer(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		let cached: SessionStats | undefined;

		// Usage totals scan (and getEntries() copies) the whole session, and the footer renders
		// every frame. Every append moves the leaf, so the totals and context usage only change
		// with the session, the leaf, or the model whose context window applies.
		const stats = (): SessionStats => {
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			const model = ctx.model;
			if (cached && cached.sessionId === sessionId && cached.leafId === leafId && cached.model === model) return cached;
			const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
			const add = (usage: Usage) => {
				totals.input += usage.input;
				totals.output += usage.output;
				totals.cacheRead += usage.cacheRead;
				totals.cacheWrite += usage.cacheWrite;
				totals.cost += usage.cost.total;
			};
			let cacheHitRate: number | undefined;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "usage") add(entry.usage);
				else if (entry.type === "message" && entry.message.role === "assistant") {
					const usage = entry.message.usage;
					add(usage);
					const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
					cacheHitRate = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
				} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
					add(entry.message.usage);
				} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
					add(entry.usage);
				}
			}
			cached = { sessionId, leafId, model, ...totals, cacheHitRate, contextUsage: ctx.getContextUsage() };
			return cached;
		};

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const { input, output, cacheRead, cacheWrite, cost, cacheHitRate, contextUsage } = stats();
					const model = ctx.model;

					let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const parts: string[] = [];
					if (input) parts.push(`↑${formatTokens(input)}`);
					if (output) parts.push(`↓${formatTokens(output)}`);
					if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
					if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
					if ((cacheRead > 0 || cacheWrite > 0) && cacheHitRate !== undefined) parts.push(`CH${cacheHitRate.toFixed(1)}%`);
					const usingSubscription = isUsingSubscription(ctx);
					if (cost || usingSubscription) parts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const percent = contextUsage?.percent ?? 0;
					const auto = pi.getSettings().compaction?.enabled !== false ? " (auto)" : "";
					const percentText = contextUsage?.percent !== null ? `${percent.toFixed(1)}%` : "?";
					const context = `${percentText}/${formatTokens(contextWindow)}${auto}`;
					parts.push(percent > 90 ? theme.fg("error", context) : percent > 70 ? theme.fg("warning", context) : context);
					if (process.env.PI_EXPERIMENTAL === "1") parts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);

					let modelText = model?.id || "no-model";
					if (model?.reasoning) {
						const level = pi.getThinkingLevel() || "off";
						modelText = level === "off" ? `${modelText} • thinking off` : `${modelText} • ${level}`;
					}
					const withProvider = footerData.getAvailableProviderCount() > 1 && model ? `(${model.provider}) ${modelText}` : undefined;

					// The context percentage may carry a color that ends in a reset, which would clear
					// an outer dim, so the stats and the model are dimmed separately.
					const layout = layoutStats(parts.join(" "), modelText, withProvider, width);
					const lines = [truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."))];
					if (layout.wrapped) lines.push(theme.fg("dim", layout.stats), theme.fg("dim", layout.model));
					else lines.push(theme.fg("dim", layout.stats) + theme.fg("dim", layout.model));

					const statuses = footerData.getExtensionStatuses();
					if (statuses.size > 0) {
						const statusLine = [...statuses.entries()]
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}
					return lines;
				},
			};
		});
	});
}
