import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Select one complete layout, keeping its catalog, mappings, and index together. */
export function resolveKnowledgeRoot(
	packageRoot: string,
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const configured = env.PI_SOFTWARE_KB_ROOT;
	if (configured !== undefined) {
		if (!isAbsolute(configured)) throw new Error("PI_SOFTWARE_KB_ROOT must be an absolute path to a complete KB layout");
		return configured;
	}
	const local = join(home, ".pi", "knowledge", "software-engineering");
	// Do not hide an incomplete local layout by silently falling back to another corpus.
	return existsSync(local) ? local : join(packageRoot, "knowledge", "software-engineering");
}
