import { appendFileSync } from "node:fs";
const mode = process.argv[2] ?? "normal";
const log = process.argv[3];
let buffer = Buffer.alloc(0);
let document;
function send(value) {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  if (mode === "fragmented") {
    for (let i = 0; i < frame.length; i += 3) process.stdout.write(frame.subarray(i, i + 3));
  } else process.stdout.write(frame);
}
function respond(request, result) { send({ jsonrpc: "2.0", id: request.id, result }); }
process.stdin.on("data", data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const index = buffer.indexOf("\r\n\r\n");
    if (index < 0) return;
    const length = Number(buffer.subarray(0, index).toString().split(":")[1]);
    if (buffer.length < index + 4 + length) return;
    const request = JSON.parse(buffer.subarray(index + 4, index + 4 + length));
    buffer = buffer.subarray(index + 4 + length);
    if (log) appendFileSync(log, JSON.stringify(request) + "\n");
    if (request.method === "initialize") {
      if (mode === "crash") process.exit(7);
      if (mode === "hang") continue;
      if (mode === "oversize") { process.stdout.write("Content-Length: 99999999\r\n\r\n"); continue; }
      if (mode === "badheader") { process.stdout.write("Content-Length: 3\r\nContent-Length: 3\r\n\r\n{}"); continue; }
      if (mode === "badjson") { process.stdout.write("Content-Length: 2\r\n\r\nxx"); continue; }
      if (mode === "badresponse") { send({ jsonrpc: "2.0", id: request.id, result: {}, error: null }); continue; }
      if (mode === "headerflood") { process.stdout.write("x".repeat(9000)); continue; }
      const initialized = { serverInfo: { name: "fake-😀" }, capabilities: {
        positionEncoding: mode === "utf8" ? "utf-8" : mode === "utf32" ? "utf-32" : "utf-16",
        textDocumentSync: 1, definitionProvider: true, referencesProvider: true, hoverProvider: true,
        ...(mode === "malformed-diagnostics" ? { executeCommandProvider: { commands: ["typescript.tsserverRequest"] } } : {}),
      } };
      if (mode === "stderr") process.stderr.write("x".repeat(2 * 1024 * 1024), () => respond(request, initialized));
      else respond(request, initialized);
    } else if (request.method === "textDocument/didOpen") document = request.params.textDocument;
    else if (request.method === "textDocument/didChange") document = { ...document, version: request.params.textDocument.version, text: request.params.contentChanges[0].text };
    else if (request.method === "textDocument/hover") {
      if (mode === "queryhang") continue;
      if (mode === "methoderror") { send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not supported" } }); continue; }
      if (mode === "editrequest") {
        send({ jsonrpc: "2.0", id: "server-edit", method: "workspace/applyEdit", params: { edit: {} } });
      }
      if (mode === "delay") setTimeout(() => respond(request, { contents: document.text }), 250);
      else respond(request, { contents: document.text });
    } else if (request.method === "workspace/executeCommand") {
      // A plausible green push must not override a malformed synchronous response.
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, diagnostics: [] } });
      respond(request, { type: "response", success: true, body: [{ message: "missing range" }] });
    } else if (request.method === "shutdown") {
      if (mode !== "stubborn") respond(request, null);
    } else if (request.method === "exit") { if (mode !== "stubborn") process.exit(0); }
    else if (request.id !== undefined && request.method) respond(request, null);
  }
});
if (mode === "stubborn") process.on("SIGTERM", () => {});
