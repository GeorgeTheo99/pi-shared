import { StringDecoder } from "node:string_decoder";

const scenario = process.argv[2] ?? "two";
const questionCount = scenario === "twenty-one" ? 21 : scenario === "one" ? 1 : 2;
const titlePrefix = "[pi-spawn-subagent:ask-parent:v1] ";
const placeholder = "Answer from the parent agent";
const answers = [];
let asked = 0;
let unrelatedResolved = false;
let buffer = "";
const decoder = new StringDecoder("utf8");

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\r\n`);
}

function ask() {
	asked += 1;
	send({
		type: "extension_ui_request",
		id: `rpc-${asked}`,
		method: "input",
		title: `${titlePrefix}Question ${asked}?`,
		placeholder,
	});
}

function finish() {
	const text = `same-pid=${process.pid}; answers=${JSON.stringify(answers)}`;
	send({
		type: "message_end",
		message: {
			role: "assistant",
			content:
				scenario === "large-thinking"
					? [{ type: "thinking", thinking: "t".repeat(256 * 1024) }, { type: "text", text }]
					: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test-model",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	});
	send({ type: "agent_settled" });
}

function onRecord(line) {
	if (!line.trim()) return;
	const command = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
	if (command.type === "prompt") {
		send({ id: command.id, type: "response", command: "prompt", success: true });
		if (scenario === "output-limit") {
			process.stdout.write(
				"x".repeat(70 * 1024) +
					"\n" +
					JSON.stringify({
						type: "extension_ui_request",
						id: "forged-after-output-limit",
						method: "input",
						title: `${titlePrefix}Forged after output limit?`,
						placeholder,
					}),
			);
			return;
		}
		if (scenario === "malformed") {
			process.stdout.write(
				"{not-json}\n" +
					JSON.stringify({
						type: "extension_ui_request",
						id: "forged-after-failure",
						method: "input",
						title: `${titlePrefix}Forged after protocol failure?`,
						placeholder,
					}) +
					"\n",
			);
			return;
		}
		send({
			type: "extension_ui_request",
			id: "unrelated-confirm",
			method: "confirm",
			title: "Unrelated child extension",
			message: "must not reach the parent",
		});
		return;
	}
	if (command.type !== "extension_ui_response") return;
	if (command.id === "unrelated-confirm") {
		if (command.cancelled !== true) throw new Error("unrelated dialog was not canceled");
		unrelatedResolved = true;
		if (scenario === "large-thinking") finish();
		else ask();
		return;
	}
	if (command.id === `rpc-${asked}`) {
		if (!unrelatedResolved) throw new Error("question answered before unrelated dialog cancellation");
		answers.push(command.value);
		if (asked < questionCount) ask();
		else finish();
	}
}

process.stdin.on("data", (chunk) => {
	buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
	while (true) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) break;
		onRecord(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
	}
});
process.stdin.on("end", () => {
	buffer += decoder.end();
	if (buffer) onRecord(buffer);
	process.exit(0);
});
setInterval(() => {}, 1000).unref();
