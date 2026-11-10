import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Written by `pi-jobs client-config <url> <token>` or `pi-jobs token create <name> --client-config`. */
export const CLIENT_CONFIG = join(homedir(), ".config", "pi-jobs", "client.json");
export interface ClientConfig {
	url: string;
	token: string;
}

/** PI_JOBS_URL/PI_JOBS_TOKEN override the client config file; null when neither is complete. */
export function readClientConfig(env: NodeJS.ProcessEnv = process.env, file = CLIENT_CONFIG): ClientConfig | null {
	let saved: Partial<ClientConfig> = {};
	if (existsSync(file)) {
		try {
			saved = JSON.parse(readFileSync(file, "utf8")) as Partial<ClientConfig>;
		} catch {
			saved = {};
		}
	}
	const url = (env.PI_JOBS_URL || saved.url || "").trim().replace(/\/+$/, "");
	const token = (env.PI_JOBS_TOKEN || saved.token || "").trim();
	return url && token ? { url, token } : null;
}
