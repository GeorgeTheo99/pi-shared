import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
	stdio: ["ignore", "inherit", "inherit"],
});
console.log(JSON.stringify({ childPid: child.pid }));
child.unref();
process.exit(0);
