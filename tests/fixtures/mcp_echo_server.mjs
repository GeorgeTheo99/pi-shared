// Minimal stdio MCP server (newline-delimited JSON-RPC) exposing one echo tool.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const tool = {
	name: "echo_text",
	description: "Echo the given text back unchanged.",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	annotations: { readOnlyHint: true },
};

createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) return; // notifications need no reply
	if (method === "initialize") {
		send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
	} else if (method === "tools/list") {
		send({ id, result: { tools: [tool] } });
	} else if (method === "tools/call" && params.name === tool.name) {
		send({ id, result: { content: [{ type: "text", text: `echo:${params.arguments.text}` }] } });
	} else {
		send({ id, error: { code: -32601, message: `Unsupported method: ${method}` } });
	}
});
