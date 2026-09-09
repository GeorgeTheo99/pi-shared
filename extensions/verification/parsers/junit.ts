import { SaxesParser } from "saxes";
import { LIMITS, type ParsedReport } from "../types.ts";

type Tally = { tests: number; failures: number; errors: number; skipped: number };
interface Frame { name: string; attrs: Record<string, string>; counts: Tally; outcome?: "failure" | "error" | "skipped" }
const tally = (): Tally => ({ tests: 0, failures: 0, errors: 0, skipped: 0 });
/** Saxes enforces XML well-formedness; no regex XML tokenization or entity expansion. */
export function parseJunit(text: string): ParsedReport {
	if (Buffer.byteLength(text) > LIMITS.reportBytes) throw new Error("JUnit report exceeds byte limit");
	const result: ParsedReport = { adapter: "junit-saxes/1", counts: { total: 0, passed: 0, failed: 0, skipped: 0 }, failures: [], failuresOmitted: 0, limitations: ["Strict JUnit testcase subset; declared suite totals must match concrete testcases. Extensions/namespaces and DTDs are rejected."] };
	const stack: Frame[] = [];
	let nodes = 0, roots = 0;
	const parser = new SaxesParser({ xmlns: false });
	const allowed: Record<string, string[]> = {
		testsuites: ["testsuite"], testsuite: ["testsuite", "testcase", "properties", "system-out", "system-err"],
		testcase: ["failure", "error", "skipped", "system-out", "system-err", "properties"], properties: ["property"],
		property: [], failure: [], error: [], skipped: [], "system-out": [], "system-err": [],
	};
	parser.on("doctype", () => { throw new Error("JUnit DTD/entity declarations are forbidden"); });
	parser.on("error", () => { throw new Error("Malformed JUnit XML"); });
	parser.on("processinginstruction", () => { throw new Error("JUnit processing instructions unsupported"); });
	parser.on("opentag", tag => {
		if (++nodes > 200000 || stack.length >= 64 || Object.keys(tag.attributes).length > 64) throw new Error("JUnit structural limit exceeded");
		const attrs = tag.attributes as Record<string, string>;
		if (Object.entries(attrs).some(([key, value]) => key.includes(":") || key === "xmlns" || value.length > 16384)) throw new Error("JUnit namespaces/oversized attributes unsupported");
		const supportedAttrs = ["testsuites", "testsuite"].includes(tag.name)
			? ["name", "package", "id", "timestamp", "hostname", "tests", "failures", "errors", "skipped", "disabled", "time", "file"]
			: tag.name === "testcase" ? ["name", "classname", "time", "file", "line", "assertions"]
			: ["failure", "error", "skipped"].includes(tag.name) ? ["message", "type"]
			: tag.name === "property" ? ["name", "value"] : [];
		if (Object.keys(attrs).some(key => !supportedAttrs.includes(key))) throw new Error("Unsupported JUnit attribute (outcome semantics cannot be inferred)");
		const parent = stack.at(-1);
		if (!parent) { if (++roots !== 1 || !["testsuites", "testsuite"].includes(tag.name)) throw new Error("Invalid JUnit root"); }
		else if (!allowed[parent.name]?.includes(tag.name)) throw new Error("Unsupported JUnit element placement");
		if (["failure", "error", "skipped"].includes(tag.name)) {
			if (!parent || parent.outcome) throw new Error("Conflicting/multiple JUnit outcomes");
			parent.outcome = tag.name as Frame["outcome"];
		}
		stack.push({ name: tag.name, attrs, counts: tally() });
	});
	const onText = (text: string) => {
		if (text.trim() && !["failure", "error", "skipped", "property", "system-out", "system-err"].includes(stack.at(-1)?.name || "")) throw new Error("Unexpected text in JUnit structure");
	};
	parser.on("text", onText); parser.on("cdata", onText);
	parser.on("closetag", () => {
		const frame = stack.pop()!;
		if (frame.name === "testcase") {
			if (++result.counts.total > LIMITS.tests) throw new Error("JUnit test limit exceeded");
			const failed = frame.outcome === "failure" || frame.outcome === "error";
			if (failed) {
				result.counts.failed++;
				const line = frame.attrs.line === undefined ? undefined : Number(frame.attrs.line);
				if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error("Invalid JUnit failure location");
				if (result.failures.length < LIMITS.failures) result.failures.push({ name: (frame.attrs.name || "(unnamed)").slice(0, 300), file: frame.attrs.file?.slice(0, 300), line }); else result.failuresOmitted++;
			} else if (frame.outcome === "skipped") result.counts.skipped++; else result.counts.passed++;
			for (const ancestor of stack) {
				if (!["testsuite", "testsuites"].includes(ancestor.name)) continue;
				ancestor.counts.tests++;
				if (frame.outcome === "failure") ancestor.counts.failures++;
				if (frame.outcome === "error") ancestor.counts.errors++;
				if (frame.outcome === "skipped") ancestor.counts.skipped++;
			}
		} else if (["testsuite", "testsuites"].includes(frame.name)) {
			for (const key of ["tests", "failures", "errors", "skipped", "disabled"]) {
				const value = frame.attrs[key];
				if (value !== undefined && (!/^\d+$/.test(value) || Number(value) !== (key === "disabled" ? 0 : frame.counts[key as keyof Tally]))) throw new Error(`Inconsistent JUnit ${key} count`);
			}
		}
	});
	parser.write(text).close();
	if (roots !== 1 || stack.length) throw new Error("Missing/incomplete JUnit document");
	return result;
}
