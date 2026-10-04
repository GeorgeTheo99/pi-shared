// One-shot Pi stand-in: leaves a detached "background job" group registered in
// the ledger (as the child Bash override would), then answers and settles.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [mode = "exit", pidFile] = process.argv.slice(2);
const ledger = process.env.PI_SUBAGENT_PGID_LEDGER;
const background = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
	detached: true,
	stdio: "ignore",
});
background.unref();
fs.appendFileSync(ledger, `${background.pid}\n`);
if (mode === "garbage") fs.appendFileSync(ledger, "not-a-group\n");
if (pidFile) fs.writeFileSync(pidFile, String(background.pid));

const assistant = (text, extra = {}) => ({
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	},
});
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
send({ type: "agent_start" });
if (mode === "retry") send(assistant("", { stopReason: "error", errorMessage: "transient provider error" }));
send(assistant(`answer:${mode}`));
send({ type: "agent_settled" });
// Real Pi disposes its runtime after settling with its SIGTERM handler already removed.
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "slow-dispose" && pidFile) {
	setTimeout(() => {
		fs.writeFileSync(`${pidFile}.disposed`, "yes");
		process.exit(0);
	}, 800);
}
