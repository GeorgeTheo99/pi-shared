import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Written by `pi-jobs client-config <url>` or `pi-jobs token create <name> --client-config`. */
export const CLIENT_CONFIG = join(homedir(), ".config", "pi-jobs", "client.json");

export interface ClientConfig {
	url: string;
	token: string;
}

export type ConfigResult = { config: ClientConfig } | { config: null; warning?: string };

function ipv4(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
	const octets = parts.map(Number);
	return octets.every((n) => n <= 255) ? octets : null;
}

/** For a WHATWG-normalized URL hostname: this machine itself. */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return host === "localhost" || host === "::1" || ipv4(host)?.[0] === 127;
}

/** Loopback and Tailscale addresses, where plain HTTP is acceptable (Tailscale encrypts the link). */
function isPrivateLink(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (isLoopbackHost(host) || host.endsWith(".ts.net") || /^fd7a:115c:a1e0:/.test(host)) return true;
	const ip = ipv4(host);
	return ip !== null && ip[0] === 100 && ip[1]! >= 64 && ip[1]! <= 127;
}

/**
 * The server URL and token, taken together from PI_JOBS_URL/PI_JOBS_TOKEN or together from the
 * client config file, so a token is never sent to a URL it wasn't saved with. Plain HTTP is
 * accepted only for loopback and tailnet hosts.
 */
export function readClientConfig(env: NodeJS.ProcessEnv = process.env, file = CLIENT_CONFIG): ConfigResult {
	let url: string | undefined;
	let token: string | undefined;
	let source: string;
	if (env.PI_JOBS_URL || env.PI_JOBS_TOKEN) {
		({ PI_JOBS_URL: url, PI_JOBS_TOKEN: token } = env);
		source = "PI_JOBS_URL and PI_JOBS_TOKEN";
		if (!url || !token) return { config: null, warning: "pi-jobs tools disabled: set both PI_JOBS_URL and PI_JOBS_TOKEN, or neither to use the client config file." };
	} else {
		if (!existsSync(file)) return { config: null };
		source = file;
		try {
			({ url, token } = JSON.parse(readFileSync(file, "utf8")) as Partial<ClientConfig>);
		} catch {
			return { config: null, warning: `pi-jobs tools disabled: ${file} is not valid JSON.` };
		}
		if (typeof url !== "string" || typeof token !== "string" || !url.trim() || !token.trim()) {
			return { config: null, warning: `pi-jobs tools disabled: ${file} needs both "url" and "token".` };
		}
	}
	const parsed = URL.parse(url.trim());
	if (!parsed || !/^https?:$/.test(parsed.protocol)) return { config: null, warning: `pi-jobs tools disabled: the URL in ${source} is not http(s).` };
	if (parsed.protocol === "http:" && !isPrivateLink(parsed.hostname)) {
		return { config: null, warning: `pi-jobs tools disabled: ${parsed.host} is neither loopback nor on the tailnet, so its token would travel unencrypted. Use https.` };
	}
	return { config: { url: url.trim().replace(/\/+$/, ""), token: token.trim() } };
}
