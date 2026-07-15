const message = {
	role: "assistant",
	content: [{ type: "text", text: "one-shot-ok" }],
	api: "test",
	provider: "test",
	model: "test-model",
	usage: {
		input: 4,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};
process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
