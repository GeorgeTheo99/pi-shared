const [stateDir, prefix, countRaw = "10"] = process.argv.slice(2);
process.env.PI_SUBAGENT_STATE_DIR = stateDir;
const { upsertStoredJob } = await import("../../extensions/_shared/job-store.ts");
const now = new Date();
for (let index = 0; index < Number(countRaw); index++) {
	await upsertStoredJob({
		id: `${prefix}-${index}`,
		status: "completed",
		startedAt: now.toISOString(),
		updatedAt: now.toISOString(),
		label: `${prefix} ${index}`,
	});
}
