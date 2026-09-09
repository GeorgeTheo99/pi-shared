import { LIMITS, type ParsedReport } from "../types.ts";

/** Deliberately strict flat TAP 13/14 subset. Unsupported constructs fail closed. */
export function parseTap(text: string): ParsedReport {
	if (Buffer.byteLength(text) > LIMITS.reportBytes) throw new Error("TAP report exceeds byte limit");
	const result: ParsedReport = { adapter: "tap-flat/1", counts: { total: 0, passed: 0, failed: 0, skipped: 0 }, failures: [], failuresOmitted: 0, limitations: ["Flat TAP only; nested subtests, TODO and YAML semantics unsupported. Diagnostics are not interpreted."] };
	let plan: number | undefined, endPlan = false, diagnostics = false, previousTest = false, version = false;
	const lines = text.split(/\r?\n/);
	if (lines.length > 100000) throw new Error("TAP line limit exceeded");
	for (const line of lines) {
		if (line.length > 16384) throw new Error("TAP line too long");
		if (diagnostics) {
			if (/^ {2,}\.\.\.\s*$/.test(line)) diagnostics = false;
			else if (line.trim() && !/^ {2}/.test(line)) throw new Error("Malformed TAP diagnostic block");
			continue;
		}
		if (!line.trim() || line.startsWith("#")) continue;
		if (/^TAP version (13|14)$/.test(line)) {
			if (version || plan !== undefined || result.counts.total) throw new Error("Misplaced TAP version");
			version = true; continue;
		}
		if (/^Bail out!/i.test(line)) throw new Error("TAP bailout");
		if (/^ {2,}---\s*$/.test(line) && previousTest) { diagnostics = true; previousTest = false; continue; }
		const p = /^1\.\.(\d+)(?:\s+#\s*SKIP(?:\s.*)?)?$/.exec(line);
		if (p) {
			if (plan !== undefined) throw new Error("Duplicate TAP plan");
			plan = Number(p[1]);
			if (!Number.isSafeInteger(plan) || plan > LIMITS.tests || (line.includes("#") && plan !== 0)) throw new Error("Invalid TAP plan");
			endPlan = result.counts.total > 0; previousTest = false; continue;
		}
		const point = /^(not ok|ok)(?:\s+(\d+))?(?:\s+-?\s*(.*))?$/.exec(line);
		if (!point || endPlan) throw new Error("Unsupported/malformed TAP line or test after final plan");
		const name = point[3] || "(unnamed)";
		if (/#\s*TODO\b/i.test(name)) throw new Error("TAP TODO requires an unsupported policy");
		const n = ++result.counts.total;
		if (n > LIMITS.tests || (point[2] !== undefined && Number(point[2]) !== n)) throw new Error("Non-contiguous TAP numbering or test limit exceeded");
		if (point[1] === "not ok") {
			result.counts.failed++;
			if (result.failures.length < LIMITS.failures) result.failures.push({ name: name.slice(0, 300) }); else result.failuresOmitted++;
		} else if (/#\s*SKIP\b/i.test(name)) result.counts.skipped++;
		else result.counts.passed++;
		previousTest = true;
	}
	if (diagnostics || plan === undefined || plan !== result.counts.total) throw new Error("Missing/inconsistent TAP plan or incomplete diagnostics");
	return result;
}
