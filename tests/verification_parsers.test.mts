import assert from "node:assert/strict";
import test from "node:test";
import { parseTap } from "../extensions/verification/parsers/tap.ts";
import { parseJunit } from "../extensions/verification/parsers/junit.ts";

const pass = { total: 1, passed: 1, failed: 0, skipped: 0 };
test("flat TAP passing, mixed failures, skipped, empty, diagnostics and plan-first", () => {
	assert.deepEqual(parseTap("TAP version 13\nok 1 - works\n  ---\n  duration_ms: 1\n  ...\n1..1\n").counts, pass);
	assert.deepEqual(parseTap("1..3\nok 1\nnot ok 2 - fails\nok 3 - later # SKIP unavailable\n").counts, { total: 3, passed: 1, failed: 1, skipped: 1 });
	assert.equal(parseTap("1..0 # SKIP explicit").counts.total, 0);
	assert.equal(parseTap("1..1\nnot ok 1 # SKIP never overrides failure").counts.failed, 1);
});
for (const [name, input] of Object.entries({
	empty: "", missingPlan: "ok 1", mismatch: "ok 1\n1..2", missingTest: "1..1", duplicatePlan: "1..0\n1..0",
	invalidSkipPlan: "1..1 # SKIP all\nok 1", duplicateNumber: "ok 1\nok 1\n1..2", bailout: "ok 1\nBail out! failure\n1..1", todo: "not ok 1 # TODO later\n1..1",
	nested: "    not ok 1\nok 1\n1..1", trailing: "ok 1\n1..1\nnot ok 2", prose: "All 10 tests passed", malformed: "okay 1\n1..1",
	brokenDiagnostic: "ok 1\n  ---\n  duration: 1\n1..1", diagnosticWithoutTest: "  ---\n  ...\n1..0",
})) test(`TAP rejects ${name}`, () => assert.throws(() => parseTap(input)));

test("JUnit real testcases, nested aggregates, failure locations and safe character references", () => {
	assert.deepEqual(parseJunit('<testsuite tests="1" failures="0"><testcase name="a &amp; b"/></testsuite>').counts, pass);
	const mixed = parseJunit('<testsuites tests="3" failures="1" skipped="1"><testsuite tests="3"><testcase name="one"/><testsuite tests="2"><testcase name="bad" file="a.ts" line="9"><failure><![CDATA[expected < actual]]></failure></testcase><testcase name="skip"><skipped/></testcase></testsuite></testsuite></testsuites>');
	assert.deepEqual(mixed.counts, { total: 3, passed: 1, failed: 1, skipped: 1 });
	assert.deepEqual(mixed.failures, [{ name: "bad", file: "a.ts", line: 9 }]);
	assert.equal(parseJunit('<testsuite tests="0"/>').counts.total, 0);
	assert.equal(parseJunit('<testsuite><testcase><error>bad</error></testcase></testsuite>').counts.failed, 1);
});
for (const [name, input] of Object.entries({
	empty: "", malformed: "<testsuite><testcase></testsuite>", missingCases: '<testsuite tests="1"/>',
	lyingGreen: '<testsuite tests="1" failures="0"><testcase><failure/></testcase></testsuite>',
	lyingFailed: '<testsuite tests="1" failures="1"><testcase/></testsuite>',
	conflict: '<testsuite><testcase><failure/><skipped/></testcase></testsuite>',
	xxe: '<!DOCTYPE testsuite [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite><testcase name="&x;"/></testsuite>',
	billionLaughs: '<!DOCTYPE testsuite [<!ENTITY a "lol"><!ENTITY b "&a;&a;">]><testsuite><testcase name="&b;"/></testsuite>',
	externalDTD: '<!DOCTYPE testsuite SYSTEM "https://example.com/evil"><testsuite/>',
	undefinedEntity: '<testsuite><testcase name="&evil;"/></testsuite>',
	summaryOnly: '<testsuites tests="9"/>', misplacedFailure: '<testsuite><failure/></testsuite>',
	unsupported: '<testsuite><testcase><flakyFailure/></testcase></testsuite>', namespace: '<testsuite xmlns="urn:junit"><testcase/></testsuite>',
	duplicateAttributes: '<testsuite tests="1" tests="0"/>', multipleRoots: '<testsuite/><testsuite/>',
	badLocation: '<testsuite><testcase line="NaN"><failure/></testcase></testsuite>',
	pi: '<?run command="evil"?><testsuite/>', invalidChar: '<testsuite><testcase name="\u0000"/></testsuite>',
	nestedText: '<testsuite>failed<testcase/></testsuite>',
	unsupportedStatus: '<testsuite><testcase status="failed"/></testsuite>',
})) test(`JUnit rejects ${name}`, () => assert.throws(() => parseJunit(input)));

test("adapter resource and failure detail bounds", () => {
	assert.throws(() => parseJunit('<testsuite>'.repeat(65) + '</testsuite>'.repeat(65)), /limit/);
	assert.throws(() => parseTap("#".repeat(2 * 1024 * 1024 + 1)), /limit/);
	assert.throws(() => parseJunit(" ".repeat(2 * 1024 * 1024 + 1)), /limit/);
	const tap = parseTap(Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} - failure`).join("\n") + "\n1..30");
	assert.equal(tap.counts.failed, 30); assert.equal(tap.failures.length, 20); assert.equal(tap.failuresOmitted, 10);
});
