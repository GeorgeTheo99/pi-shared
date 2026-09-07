import fs from "node:fs";
import { withInterprocessLock } from "../../extensions/_shared/file-lock.ts";

const [lockPath, counterPath, iterations = "10"] = process.argv.slice(2);
for (let index = 0; index < Number(iterations); index++) {
	await withInterprocessLock(lockPath, async () => {
		// Exclusive create is an independent witness that critical sections do not overlap.
		const guard = `${counterPath}.critical`;
		const fd = fs.openSync(guard, "wx");
		try {
			const current = Number(fs.readFileSync(counterPath, "utf8"));
			await new Promise((resolve) => setTimeout(resolve, 2));
			fs.writeFileSync(counterPath, String(current + 1));
		} finally {
			fs.closeSync(fd);
			fs.unlinkSync(guard);
		}
	}, { staleMs: 1, timeoutMs: 10_000, retryMs: 2 });
}
