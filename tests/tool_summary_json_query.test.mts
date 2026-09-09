import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  JsonQueryError, MAX_JSON_SOURCE_CHARS, pointerTokens, selectJsonSpan, serializeDetails,
} from "../extensions/tool-summary/json-query.ts";
import { executeRecall, type RecallParams } from "../extensions/tool-summary/recall.ts";

function selected(text: string, pointer: string) {
  const span = selectJsonSpan(text, pointer);
  return span ? text.slice(span.start, span.end) : undefined;
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof JsonQueryError && error.code === code;
}

test("pointer spans preserve every numeric/string lexeme, whitespace, and root offsets", () => {
  const text = ' \r\n{"id":9007199254740993,"numbers":[-0,1.2300e+004,1e999,-9007199254740993123456789],"s":"\\u0061\\n"} \n';
  for (const [pointer, exact] of [
    ["/id", "9007199254740993"], ["/numbers/0", "-0"], ["/numbers/1", "1.2300e+004"],
    ["/numbers/2", "1e999"], ["/numbers/3", "-9007199254740993123456789"], ["/s", '"\\u0061\\n"'],
  ]) assert.equal(selected(text, pointer), exact);
  assert.equal(selected(text, ""), text.trim());
  assert.deepEqual(selectJsonSpan(" null \r\n", ""), { start: 1, end: 5, valueType: "null" });
});

test("escaped and empty tokens, Unicode keys, prototype names, and arrays follow RFC 6901", () => {
  const text = '{"a/b":{"~":{"":7}},"~1":8,"\\u0062":9,"👋":10,"__proto__":{"constructor":11},"01":12,"a":[null,false,{},[]]}';
  assert.deepEqual(pointerTokens("/a~1b/~0/"), ["a/b", "~", ""]);
  for (const [pointer, exact] of [["/a~1b/~0/", "7"], ["/~01", "8"], ["/a", '[null,false,{},[]]'], ["/👋", "10"], ["/__proto__/constructor", "11"], ["/01", "12"]]) {
    assert.equal(selected(text, pointer), exact);
  }
  assert.equal(selected('{"\\u0061":9}', "/a"), "9");
  assert.equal(selected("[null,false,{},[]]", "/0"), "null");
  assert.equal(selected("[null,false,{},[]]", "/1"), "false");
  assert.equal(selected("[null]", "/1"), undefined);
  assert.equal(selected("{}", "/toString"), undefined);
  assert.equal(selected("null", "/x"), undefined);
  assert.equal(selected("[]", "/9007199254740993123456789"), undefined);
});

test("invalid pointers and array indices fail clearly", () => {
  for (const pointer of ["x", "#/x", "/~", "/~2", "/~01/~x", "/".repeat(4097)]) {
    assert.throws(() => selected("{}", pointer), errorCode("invalid_pointer"));
  }
  for (const pointer of ["/01", "/-", "/+1", "/-1", "/1.0", "/x", "/"]) {
    assert.throws(() => selected("[1,2]", pointer), errorCode("invalid_array_index"));
  }
});

test("malformed JSON anywhere is rejected, even after a valid selected value", () => {
  for (const source of ["", " ", "undefined", "NaN", "01", "+1", "1.", "1e", "--1", "[1,]", '{"a":1,}', '{"a":1 "b":2}', '{a:1}', '"\\x"', '"\\u00fg"', '"a\nb"', '"unterminated', "true false", '{"a":1,"b":[false,]}', '\uFEFF{}']) {
    assert.throws(() => selected(source, "/a"), errorCode("invalid_json"), source);
  }
});

test("duplicate keys are ambiguous, including escaped duplicates and unrelated subtrees", () => {
  for (const source of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1,"other":{"x":2,"x":3}}']) {
    assert.throws(() => selected(source, "/a"), errorCode("ambiguous_pointer"));
  }
});

test("input, depth, and node guards refuse oversized documents instead of partially evaluating them", () => {
  assert.throws(() => selected('"' + "x".repeat(MAX_JSON_SOURCE_CHARS) + '"', ""), errorCode("input_too_large"));
  assert.throws(() => selected("[".repeat(130) + "0" + "]".repeat(130), ""), errorCode("complexity_limit"));
  assert.throws(() => selected("[" + "0,".repeat(200_000) + "0]", "/0"), errorCode("complexity_limit"));
});

test("stored details use explicit JSON serialization fidelity and handle unrepresentable data", () => {
  assert.equal(serializeDetails(null), "null");
  assert.equal(serializeDetails({ id: JSON.parse("9007199254740993"), omitted: undefined }), '{"id":9007199254740992}');
  assert.equal(serializeDetails([undefined, NaN, Infinity]), "[null,null,null]");
  const cyclic: any = {}; cyclic.self = cyclic;
  for (const value of [undefined, 1n, cyclic]) {
    assert.throws(() => serializeDetails(value), errorCode("details_not_serializable"));
  }
  assert.throws(() => serializeDetails({ x: "x".repeat(MAX_JSON_SOURCE_CHARS + 1) }), errorCode("input_too_large"));
});

function entry(id = "call-exact", text = '{"id":9007199254740993}', details?: unknown): any {
  return { type: "message", id: `entry-${id}`, message: {
    role: "toolResult", toolName: "custom", toolCallId: id, isError: false,
    content: [{ type: "text", text }], ...(details !== undefined ? { details } : {}),
  } };
}
function context(branch: any[], all: any[] = branch): any {
  return { sessionManager: { getBranch: () => branch, getEntries: () => all, getSessionId: () => "session-exact" } };
}
function recall(source: any, patch: Partial<RecallParams> = {}) {
  return executeRecall({ toolCallId: source.message.toolCallId, operation: "json-pointer", source: "text", contentIndex: 0, pointer: "/id", ...patch }, context([source]));
}
function body(result: ReturnType<typeof executeRecall>) {
  return result.content[0]!.text.split("[Begin selected JSON]\n")[1]?.split("\n[End selected JSON]")[0];
}

test("recall exposes exact selection, original provenance and hashes without altering stored messages", () => {
  const source = entry();
  const before = structuredClone(source);
  const result = recall(source);
  assert.equal(body(result), "9007199254740993");
  assert.equal(result.details.status, "ok");
  assert.equal(result.details.exact, true);
  assert.equal(result.details.valueType, "number");
  assert.equal(result.details.version, 1);
  const provenance = result.details.provenance as any;
  assert.equal(provenance.sessionId, "session-exact");
  assert.equal(provenance.entryId, source.id);
  assert.equal(provenance.toolCallId, source.message.toolCallId);
  assert.equal(provenance.fidelity, "original-text-lexemes");
  assert.equal(provenance.sourceSha256, createHash("sha256").update(source.message.content[0].text).digest("hex"));
  assert.equal(provenance.contentSha256, createHash("sha256").update(JSON.stringify(source.message.content)).digest("hex"));
  assert.match(result.content[0]!.text, /untrusted data/);
  assert.match(result.content[0]!.text, /upstream-truncated or absent data cannot be recovered/);
  assert.deepEqual(source, before);
});

test("sources and original content-array indices must be explicit; text parts are never concatenated", () => {
  const source = entry();
  source.message.content = [{ type: "text", text: "not JSON" }, { type: "image", data: "png", mimeType: "image/png" }, { type: "text", text: '{"id":42}' }];
  for (const [patch, error] of [
    [{ source: undefined }, "source_required"], [{ pointer: undefined }, "pointer_required"],
    [{ contentIndex: undefined }, "content_index_required"], [{ contentIndex: -1 }, "content_index_required"],
    [{ contentIndex: 1.5 }, "content_index_required"], [{ contentIndex: 1 }, "text_part_not_found"],
    [{ contentIndex: 99 }, "text_part_not_found"], [{ contentIndex: 0 }, "invalid_json"],
    [{ source: "details" }, "invalid_source_options"],
  ] as const) assert.equal(recall(source, patch as any).details.error, error);
  assert.equal(body(recall(source, { contentIndex: 2 })), "42");
  source.message.content = [{ type: "text", text: '{"id":' }, { type: "text", text: '42}' }];
  assert.equal(recall(source).details.error, "invalid_json");
});

test("null, missing targets, absent details and invalid JSON are distinct outcomes", () => {
  const source = entry("call-exact", '{"id":null}', null);
  const explicitNull = recall(source);
  assert.equal(explicitNull.details.status, "ok");
  assert.equal(explicitNull.details.matched, true);
  assert.equal(explicitNull.details.valueType, "null");
  assert.equal(body(explicitNull), "null");
  const missing = recall(source, { pointer: "/missing" });
  assert.equal(missing.details.status, "missing");
  assert.equal(missing.details.found, true);
  assert.equal(missing.details.matched, false);
  assert.equal(body(missing), undefined);
  assert.equal(body(recall(source, { source: "details", contentIndex: undefined, pointer: "" })), "null");
  assert.equal(recall(entry(), { source: "details", contentIndex: undefined }).details.error, "details_missing");
  assert.equal(recall(entry("call-exact", "not json")).details.error, "invalid_json");
});

test("details-only recall works without text and discloses already-rounded JavaScript values and truncation", () => {
  const source = entry("call-exact", "", { id: JSON.parse("9007199254740993"), truncation: { truncated: true } });
  source.message.content = [];
  source.message.isError = true;
  const result = recall(source, { source: "details", contentIndex: undefined });
  assert.equal(body(result), "9007199254740992");
  assert.equal((result.details.provenance as any).fidelity, "stored-javascript-json-serialization");
  assert.equal((result.details.provenance as any).upstreamTruncation, "reported");
  assert.equal((result.details.provenance as any).isError, true);
  assert.match(result.content[0]!.text, /original number lexemes are unavailable/);
  assert.equal((recall(entry()).details.provenance as any).upstreamTruncation, "unknown");
});

test("wrong branches, prefix call IDs and reused IDs never select a guessed result", () => {
  const inactive = entry("call-secret", '{"id":"secret"}');
  const active = entry();
  const params: RecallParams = { toolCallId: "call-secret", operation: "json-pointer", source: "text", contentIndex: 0, pointer: "/id" };
  assert.equal(executeRecall(params, context([active], [active, inactive])).details.error, "result_not_found");
  assert.equal(executeRecall({ ...params, toolCallId: "call" }, context([active])).details.error, "result_not_found");
  for (const duplicate of [entry(), entry("call-exact", '{"id":2}'), entry("call-exact", active.message.content[0].text, { secret: true })]) {
    duplicate.id = "other-entry";
    const result = executeRecall({ ...params, toolCallId: "call-exact" }, context([active, duplicate]));
    assert.equal(result.details.error, "ambiguous_call_id");
    assert.equal(body(result), undefined);
  }
});

test("oversized and multiline selections are omitted, never returned as partial JSON", () => {
  for (const value of ['"' + "x".repeat(50_000) + '"', '"' + "界".repeat(20_000) + '"', "[\n" + "0,\n".repeat(2000) + "0\n]"]) {
    const source = entry("call-exact", `{"id":${value},"small":7}`);
    const result = recall(source);
    assert.equal(result.details.status, "error");
    assert.equal(result.details.error, "selection_too_large");
    assert.equal(result.details.exact, false);
    assert.equal(result.details.omitted, true);
    assert.equal(result.details.truncated, false);
    assert.equal(body(result), undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 50_000);
    assert.equal(body(recall(source, { pointer: "/small" })), "7");
  }
});

test("oversized provenance and caller IDs produce bounded diagnostics", () => {
  const source = entry();
  source.message.toolName = "界".repeat(20_000);
  let result = recall(source);
  assert.equal(result.details.error, "metadata_too_large");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50_000);
  result = recall(entry(), { toolCallId: "x".repeat(100_000) });
  assert.equal(result.details.error, "invalid_call_id");
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50_000);
});
