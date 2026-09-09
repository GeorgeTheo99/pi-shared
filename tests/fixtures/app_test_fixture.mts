import http from "node:http";
import type { AddressInfo } from "node:net";

export async function appFixture() {
	let refusedHits = 0;
	let mutations = 0;
	const blocked = http.createServer((_req, res) => { refusedHits++; res.end("forbidden destination"); });
	await new Promise<void>(resolve => blocked.listen(0, "127.0.0.1", resolve));
	// localhost is deliberately NOT allowed; both servers are entirely local fixtures.
	const forbidden = `http://localhost:${(blocked.address() as AddressInfo).port}`;
	const server = http.createServer((req, res) => {
		if (req.url === "/redirect") { res.writeHead(302, { Location: "/redirect-final" }).end(); return; }
		if (req.url === "/redirect-final") { res.writeHead(302, { Location: "/" }).end(); return; }
		if (req.url === "/escape") { res.writeHead(302, { Location: "/escape-second" }).end(); return; }
		if (req.url === "/escape-second") { res.writeHead(302, { Location: forbidden }).end(); return; }
		if (req.url === "/mutate") { mutations++; res.end("ok"); return; }
		if (req.url === "/seed") { res.setHeader("Set-Cookie", "fixture=secret; Path=/; SameSite=Lax"); }
		if (req.url === "/asset") { res.end("asset"); return; }
		res.setHeader("Content-Type", "text/html");
		res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>Fixture app</h1><label>Name <input id="name"></label><button id="save">Save</button><p id="count">0</p>
<p id="storage"></p><p id="cookie"></p><p id="mobile"></p><p id="width"></p>
<button id="leak">Check external requests</button><p id="network-done" hidden>Done</p>
<button id="noise">Generate bounded evidence</button><p id="long"></p>
<script>
if(location.pathname === '/seed') localStorage.setItem('fixture','secret');
document.querySelector('#storage').textContent=localStorage.getItem('fixture') || 'empty';
document.querySelector('#cookie').textContent=document.cookie || 'empty';
document.querySelector('#mobile').textContent=String(navigator.maxTouchPoints > 0);
document.querySelector('#width').textContent=String(innerWidth);
document.querySelector('#save').onclick=()=>{document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1); fetch('/mutate',{method:'POST'});};
document.querySelector('#leak').onclick=async()=>{await Promise.allSettled([fetch('${forbidden}/fetch'),fetch('/escape')]); document.querySelector('#network-done').hidden=false;};
document.querySelector('#noise').onclick=()=>{for(let i=0;i<150;i++) console.log(String(i)+'x'.repeat(700)); document.querySelector('#long').textContent='x'.repeat(30000);};
console.log('fixture console evidence'); fetch('/asset');
</script></body></html>`);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		forbidden,
		get refusedHits() { return refusedHits; },
		get mutations() { return mutations; },
		async close() { for (const s of [server, blocked]) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } },
	};
}
