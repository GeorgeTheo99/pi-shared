import http from "node:http";
import net, { type Socket } from "node:net";

/** Same hostname rules as persistent app_*, but fail closed and reject URL credentials. */
export function appTargetPolicy(baseUrl: string | undefined, rawHosts = "") {
	const hosts = new Set(rawHosts.split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
	if (baseUrl) hosts.add(new URL(baseUrl).hostname.toLowerCase());
	function check(value: string): URL {
		const url = new URL(value);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
			throw new Error("Only uncredentialed HTTP(S) app targets are supported");
		if (![...hosts].some(rule => rule.startsWith("*.") ? url.hostname.endsWith(rule.slice(1)) : url.hostname === rule))
			throw new Error(`App target host refused: ${url.hostname}`);
		return url;
	}
	return {
		check,
		resolve(value: string) {
			if (!value.trim()) throw new Error("URL cannot be empty");
			return check(new URL(value, baseUrl).href).href;
		},
	};
}

/**
 * Chromium HTTP(S) egress guard. A proxy checks EVERY redirect/subresource/tunnel,
 * unlike Playwright route(), which only sees the first URL of a redirect chain.
 * No TLS interception, credentials, response buffering or request replay.
 * This is a hostname policy for trusted app tests, not an OS/network sandbox.
 */
export async function startAppProxy(policy: ReturnType<typeof appTargetPolicy>, refused: (url: string) => void) {
	const sockets = new Set<Socket>();
	function track(socket: Socket) {
		if (sockets.size >= 256) { socket.destroy(); return; }
		sockets.add(socket);
		socket.setTimeout(30_000, () => socket.destroy());
		socket.on("error", () => socket.destroy());
		socket.on("close", () => sockets.delete(socket));
	}
	const server = http.createServer((req, res) => {
		let url: URL;
		try {
			url = policy.check(req.url ?? "");
			if (url.protocol !== "http:") throw new Error("HTTPS requires CONNECT");
		} catch {
			refused(req.url ?? ""); res.writeHead(403).end("App target refused"); return;
		}
		const headers = { ...req.headers, host: url.host };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const upstream = http.request(url, { method: req.method, headers, agent: false }, response => {
			res.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(res);
			response.on("error", () => res.destroy());
		});
		upstream.on("socket", track);
		upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
		req.on("aborted", () => upstream.destroy());
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	});
	server.on("connection", track);
	server.on("connect", (req, client, head) => {
		let url: URL;
		try {
			url = policy.check(`https://${req.url}`);
			if (url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid tunnel");
		} catch {
			refused(req.url ?? ""); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
		}
		const upstream = net.connect(Number(url.port || 443), url.hostname.replace(/^\[|\]$/g, ""));
		track(upstream);
		upstream.on("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream); upstream.pipe(client);
		});
		upstream.on("error", () => client.destroy());
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	// WebSockets are deliberately unsupported in this focused runner.
	server.on("upgrade", (req, socket) => { refused(req.url ?? "WebSocket"); socket.destroy(); });
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address() as net.AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			const closed = new Promise<void>(resolve => server.close(() => resolve()));
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}
