import { createSubagentExecutionGroup } from "../../extensions/_shared/subagent-scheduler.ts";
import { loadSubagentConfig } from "../../extensions/_shared/subagent-config.ts";

const [stateDir, id, holdMsRaw = "200", concurrencyRaw = "2"] = process.argv.slice(2);
const config = loadSubagentConfig({
	PI_SUBAGENT_STATE_DIR: stateDir,
	PI_SUBAGENT_MAX_FANOUT: "16",
	PI_SUBAGENT_MAX_CONCURRENCY: concurrencyRaw,
	PI_SUBAGENT_QUEUE_TIMEOUT_MS: "10000",
	PI_SUBAGENT_HEARTBEAT_MS: "1000",
	PI_SUBAGENT_LEASE_MS: "10000",
});
if (config.errors.length > 0) throw new Error(config.errors.join("\n"));
const group = createSubagentExecutionGroup(config, `fixture-${id}`);
const timing = await group.run({ label: id }, async () => {
	const start = Date.now();
	await new Promise((resolve) => setTimeout(resolve, Number(holdMsRaw)));
	return { id, start, end: Date.now() };
});
process.stdout.write(`${JSON.stringify(timing)}\n`);
