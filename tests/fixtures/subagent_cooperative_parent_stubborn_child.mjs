import { spawn } from "node:child_process";

const child = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
	{ stdio: "ignore" },
);
process.stdout.write(`${JSON.stringify({ childPid: child.pid })}\n`);
setInterval(() => {}, 1000);
