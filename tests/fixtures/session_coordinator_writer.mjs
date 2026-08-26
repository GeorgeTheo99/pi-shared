const [stateDir, roomId, targetRuntimeId, prefix, countRaw = "10"] = process.argv.slice(2);
process.env.PI_SESSION_COORDINATOR_DIR = stateDir;
const { createEnvelope, enqueueMessage } = await import("../../extensions/session-coordinator/state.ts");

const senderRuntimeId = `${prefix.slice(0, 8).padEnd(8, "0")}-0000-4000-8000-000000000000`;
for (let index = 0; index < Number(countRaw); index++) {
	await enqueueMessage(
		createEnvelope({
			roomId,
			targetRuntimeId,
			sender: {
				runtimeId: senderRuntimeId,
				sessionId: `${prefix}-session`,
				worktreeRoot: process.cwd(),
			},
			message: `${prefix}-${index}`,
		}),
	);
}
