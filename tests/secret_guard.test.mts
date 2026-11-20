import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import secretGuard, {
	defaultSecretDirs,
	redactContent,
	redactDeep,
	redactText,
	SecretIndex,
	valuesOf,
} from "../extensions/secret-guard/index.ts";

// Fake credentials assembled at runtime so this file holds no literal token.
const fake = (prefix: string, length: number, alphabet = "a1B2c3D4e5") =>
	prefix + Array.from({ length }, (_, i) => alphabet[i % alphabet.length]).join("");
const NEON = fake("napi_", 60);
const STRIPE = fake("sk_test_", 40);
const JWT = `${fake("eyJ", 20)}.${fake("eyJ", 40)}.${fake("", 43)}`;
const OPAQUE = "Zq8v-0000-opaque-vendor-token-without-prefix";

function store(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "secret-guard-"));
	const dir = join(root, "secrets");
	mkdirSync(dir);
	for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value);
	return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const noStore = { secrets: () => [], pattern: () => null };

test("secret files yield the value, its lines, assignments and URL passwords", () => {
	const values = valuesOf(`${OPAQUE}\nAPI_TOKEN="${fake("", 24)}"\nshort\npostgresql://app:${encodeURIComponent("p@ss/word-0123456789")}@db.example.com/app\n`);
	assert.ok(values.includes(OPAQUE));
	assert.ok(values.includes(fake("", 24)));
	assert.ok(values.includes("p@ss/word-0123456789"), "decoded URL password");
	assert.ok(!values.includes("short"), "values under 12 characters are ignored");
	const json = valuesOf(JSON.stringify({ tokens: { access_token: OPAQUE, expires_in: 3600, kind: "bearer" } }));
	assert.ok(json.includes(OPAQUE), "string values of a JSON store");
});

test("exact values from a secret store are redacted with the store's name, and reloaded on change", () => {
	const { dir, cleanup } = store({ vendor: `${OPAQUE}\n` });
	try {
		const index = new SecretIndex(() => [dir]);
		assert.equal(redactText(`token=${OPAQUE} end`, index).text, "token=[REDACTED secret:vendor] end");
		writeFileSync(join(dir, "vendor"), "Rotated-Value-0123456789\n");
		const later = Date.now() + 10_000;
		index.secrets(later);
		assert.equal(redactText("Rotated-Value-0123456789", { secrets: () => index.secrets(later), pattern: () => index.pattern(later) }).text,
			"[REDACTED secret:vendor]");
	} finally {
		cleanup();
	}
});

test("default stores are every ~/.config/<tool>/secrets plus PI_SECRET_DIRS", () => {
	const { root, cleanup } = store({});
	try {
		mkdirSync(join(root, ".config", "cloud-console"), { recursive: true });
		const dirs = defaultSecretDirs({ PI_SECRET_DIRS: "/extra/secrets:" }, root);
		assert.deepEqual(dirs.sort(), [join(root, ".config", "cloud-console", "secrets"), "/extra/secrets"].sort());
	} finally {
		cleanup();
	}
});

test("well-known token formats are redacted without a store", () => {
	const input = [
		`neon ${NEON}`,
		`clerk ${STRIPE}`,
		`session ${JWT}`,
		"-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
		"db postgres://app:Sup3rS3cretPassw0rd@ep-x.neon.tech/db",
		`aws ${fake("AKIA", 16, "ABCDEFGH23")}`,
	].join("\n");
	const { text, count } = redactText(input, noStore);
	assert.equal(count, 6);
	for (const leaked of [NEON, STRIPE, JWT, "Sup3rS3cretPassw0rd", "abc"]) assert.ok(!text.includes(leaked), leaked.slice(0, 8));
	assert.match(text, /neon \[REDACTED neon api key\]/);
	assert.match(text, /postgres:\/\/app:\[REDACTED password\]@ep-x\.neon\.tech/);
});

test("bare Neon role passwords and credential-named fields are redacted", () => {
	const role = fake("npg_", 12);
	const opaque = fake("", 18);
	// The 2026-11-17 leak: Keeper JSON keeps the password in a typed field, not a top-level key.
	const keeper = JSON.stringify({
		title: "db owner",
		fields: [{ type: "login", value: ["neondb_owner"] }, { type: "password", value: [opaque] }],
		custom: [{ label: "note", value: [opaque], type: "secret" }],
	}, null, 2);
	const keeperOut = redactText(keeper, noStore);
	assert.equal(keeperOut.count, 2);
	assert.ok(!keeperOut.text.includes(opaque));
	assert.ok(keeperOut.text.includes("neondb_owner"), "non-secret fields stay");

	const fields = [
		`role ${role}`,
		JSON.stringify({ client_secret: opaque, authToken: opaque, apiKey: opaque, max_tokens: 1024, token_type: "Bearer" }),
		`DB_PASSWORD=${opaque}`,
		`export GITHUB_TOKEN='${opaque}'`,
	].join("\n");
	const out = redactText(fields, noStore);
	assert.equal(out.count, 6);
	assert.ok(!out.text.includes(opaque) && !out.text.includes(role));
	assert.match(out.text, /role \[REDACTED neon role password\]/);
	assert.match(out.text, /"client_secret":"\[REDACTED field\]"/);
	assert.match(out.text, /"token_type":"Bearer"/);
	assert.match(out.text, /^DB_PASSWORD=\[REDACTED field\]$/m);
});

test("credential-named fields with placeholders, references or source code are left alone", () => {
	const input = [
		JSON.stringify({ password: "", api_key: "<your key>", token: "${TOKEN}", secret: "[REDACTED field]", apiKey: "test-key" }),
		JSON.stringify({ Authorization: "Bearer a long sentence token", OPENAI_API_KEY: "dummy" }),
		JSON.stringify({ type: "password", value: [] }),
		"GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
		"API_KEY=$(cat ~/.config/x/secrets/key)",
		"const DB_PASSWORD = process.env.DB_PASSWORD;",
		"\tpassword: input.password,",
		"PI_SECRET_GUARD=off",
	].join("\n");
	assert.deepEqual(redactText(input, noStore), { text: input, count: 0 });
});

test("typed fields keep working with symbol passwords; container, escaped and Keeper text shapes are covered", () => {
	const opaque = fake("", 18);
	const symbols = ["ab]cd!ef", 'q"uote~1x', "back\\slash9", "$tart*Pass1", "<angle>pw"];
	const keeper = JSON.stringify({
		fields: [
			...symbols.map((value) => ({ type: "password", value: [value] })),
			{ value: [opaque], label: "x", complexity: { length: 20 }, type: "secret" },
		],
	});
	const typed = redactText(keeper, noStore);
	assert.equal(typed.count, symbols.length + 1);
	for (const value of [...symbols, opaque]) assert.ok(!typed.text.includes(JSON.stringify(value).slice(1, -1)), value.slice(0, 3));
	assert.doesNotThrow(() => JSON.parse(typed.text), "redacted output is still JSON");

	const shapes = [
		`PASSWORD=${opaque}`,
		`  - POSTGRES_PASSWORD=${opaque}`,
		`      "POSTGRES_PASSWORD=${opaque}",`,
		JSON.stringify({ result: JSON.stringify({ password: opaque }) }),
		`Password: ${opaque}`,
	];
	for (const shape of shapes) {
		const out = redactText(shape, noStore);
		assert.equal(out.count, 1, shape.slice(0, 20));
		assert.ok(!out.text.includes(opaque), shape.slice(0, 20));
	}
	assert.doesNotThrow(() => JSON.parse(JSON.parse(redactText(shapes[3]!, noStore).text).result), "escaped JSON still parses");
});

test("escaped values, nested typed fields, short PINs and secret-key names are redacted", () => {
	const opaque = fake("", 18);
	const cases: [string, string][] = [
		[JSON.stringify({ password: `aB3"x${opaque}` }), `aB3\\"x${opaque}`],
		[JSON.stringify({ password: `${opaque}&<>` }).replace(/&/g, "\\u0026"), opaque],
		[JSON.stringify({ stdout: JSON.stringify({ type: "password", value: [`p]w"${opaque}`] }) }), opaque],
		[JSON.stringify({ stdout: JSON.stringify({ value: [opaque], type: "secret" }, null, 2) }), opaque],
		[JSON.stringify({ type: "password", label: "x", complexity: { length: 20 }, value: [opaque] }), opaque],
		[JSON.stringify({ fields: [{ type: "pinCode", value: ["4821"] }] }), "4821"],
		[`SECRET_KEY_BASE=${opaque}`, opaque],
		[`  - 'DB_PASSWORD=${opaque}'`, opaque],
		[`PASSWORD=aB3"${opaque}`, opaque],
		[JSON.stringify({ secretKey: opaque }), opaque],
	];
	for (const [input, leaked] of cases) {
		const out = redactText(input, noStore);
		assert.equal(out.count, 1, input.slice(0, 40));
		assert.ok(!out.text.includes(leaked), input.slice(0, 40));
		if (input.startsWith("{")) assert.doesNotThrow(() => JSON.parse(out.text), "still JSON");
	}
	const nested = redactText(cases[2]![0], noStore).text;
	assert.doesNotThrow(() => JSON.parse(JSON.parse(nested).stdout), "inner JSON still parses");
});

test("readable fixture values under credential keys stay readable", () => {
	const input = [
		JSON.stringify({ api_key: "test-api-key-value", apiKey: "OPENROUTER_API_KEY", token: "./fixtures/token.json" }),
		"DB_PASSWORD=local-dev-password",
		"Password: ********",
		JSON.stringify({ nextPageToken: fake("", 24), api_key: fake("", 10), token: "длинное-значение-токена" }),
		JSON.stringify({ path: "C:\\Users\\me\\secrets\\token.json", api_token: "C:\\keys\\db-password.txt" }),
	].join("\n");
	assert.deepEqual(redactText(input, noStore), { text: input, count: 0 });
});

test("field rules stay linear on large adversarial output", () => {
	for (const input of ['"type":"password",'.repeat(30_000), '"value":['.repeat(30_000), "\n".repeat(30_000), " \n".repeat(30_000), "a.".repeat(30_000),
		'"password":"'.repeat(30_000), '\\"password\\":\\"'.repeat(30_000), "Password: ".repeat(30_000),
		'\\"type\\":\\"password\\",'.repeat(30_000)]) {
		const started = performance.now();
		redactText(input, noStore);
		assert.ok(performance.now() - started < 500, `${JSON.stringify(input.slice(0, 12))} took too long`);
	}
});

test("ordinary text, hashes, IDs and documented placeholders are left alone", () => {
	const input = [
		"commit 5902a981e2c4b7d1f0a9b8c7d6e5f4a3b2c1d0e9",
		"id 849c2bd9-bdb5-48c2-b6ba-bbce6e9e03fe",
		"postgres://postgres:<random>@127.0.0.1:55432/postgres",
		"postgres://dessecker_app:...@127.0.0.1:55432/db",
		"pk_test_ is public; sk- alone is not a key",
	].join("\n");
	assert.deepEqual(redactText(input, noStore), { text: input, count: 0 });
});

test("images and base64 payloads pass through; nested details are redacted", () => {
	const image = { type: "image" as const, data: `${NEON}${"A".repeat(5000)}`, mimeType: "image/png" };
	const content = redactContent([{ type: "text", text: `key ${NEON}` }, image], noStore);
	assert.equal(content.count, 1);
	assert.equal(content.value[1], image);
	const details = redactDeep({ output: [`x ${STRIPE}`], exitCode: 0, blob: "QUJD".repeat(2000) }, noStore);
	assert.equal(details.count, 1);
	assert.deepEqual((details.value as { output: string[] }).output, ["x [REDACTED stripe/clerk secret key]"]);
	const clean = { a: 1, b: ["fine"] };
	assert.equal(redactDeep(clean, noStore).value, clean, "unchanged values keep their reference");
});

test("the extension rewrites tool results that contain secrets and leaves others untouched", async () => {
	const handlers = new Map<string, (event: unknown) => unknown>();
	secretGuard({ on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) } as never, noStore as never);
	const handler = handlers.get("tool_result")!;
	assert.equal(handler({ content: [{ type: "text", text: "all clear" }], details: { exitCode: 0 }, isError: false }), undefined);
	const patched = handler({
		content: [{ type: "text", text: `export NEON=${NEON}` }],
		details: { stdout: NEON },
		structuredContent: { key: NEON },
		isError: false,
	}) as { content: { text: string }[]; details: { stdout: string }; structuredContent: { key: string } };
	assert.equal(patched.content[0]!.text, "export NEON=[REDACTED neon api key]");
	assert.equal(patched.details.stdout, "[REDACTED neon api key]");
	assert.equal(patched.structuredContent.key, "[REDACTED neon api key]");
});

test("JSON stores yield credentials, not their metadata or lines", () => {
	const values = valuesOf(JSON.stringify({
		access_token: OPAQUE,
		refresh_token: "Readable-Refresh-Token-Value",
		email: "someone99@example.com",
		issuer: "https://auth.example.com",
		scopes: ["openid profile email", "offline_access"],
		expires_at: 1795204464,
	}, null, 2));
	assert.ok(values.includes(OPAQUE));
	assert.ok(values.includes("Readable-Refresh-Token-Value"), "credential-named keys are taken whatever their shape");
	for (const metadata of ["someone99@example.com", "https://auth.example.com", "openid profile email", "offline_access", '"scopes": ['])
		assert.ok(!values.includes(metadata), metadata);
	assert.ok(!valuesOf(`# vendor API key for the dev project\n${OPAQUE}\n`).includes("# vendor API key for the dev project"), "comment lines");
});

test("placeholders are template shapes, not values that start with a symbol", () => {
	for (const value of ["$tart*Pass1234-xY9", "<angle>Pass1234xY9", "{brace}Pass1234xY9", "*star-Pass1234xY9"]) {
		const out = redactText(JSON.stringify({ password: value }), noStore);
		assert.equal(out.count, 1, value);
		assert.equal(redactText(`postgres://app:${value.replace(/[<>{}]/g, "")}@db.example.com/app`, noStore).count, 1, value);
	}
	const kept = JSON.stringify({ password: "${DB_PASSWORD_VALUE}", api_key: "<your api key here>", token: "$GITHUB_TOKEN_VALUE", secret: "{{ secrets.SECRET }}" });
	assert.equal(redactText(kept, noStore).count, 0);
});

test("URL passwords: empty user is covered, ports followed by a query are not passwords", () => {
	assert.equal(redactText("redis://:my_redis_password99@127.0.0.1:6379/0", noStore).text, "redis://:[REDACTED password]@127.0.0.1:6379/0");
	for (const url of ["https://example.com:8443?next=a@b.com", "https://example.com:8443#user@host"])
		assert.deepEqual(redactText(url, noStore), { text: url, count: 0 });
	assert.equal(redactText(JSON.stringify({ secret_key_base: OPAQUE }), noStore).count, 1);
});

test("structured details are redacted by key and typed field, like their serialized form", () => {
	const value = {
		password: OPAQUE,
		nested: { client_secret: OPAQUE, nextPageToken: OPAQUE, apiKey: "test-api-key" },
		fields: [{ type: "password", value: ["Zq8v-pw"] }, { type: "login", value: ["someone"] }],
	};
	const out = redactDeep(value, noStore);
	assert.equal(out.count, 3);
	assert.deepEqual(out.value, {
		password: "[REDACTED field]",
		nested: { client_secret: "[REDACTED field]", nextPageToken: OPAQUE, apiKey: "test-api-key" },
		fields: [{ type: "password", value: ["[REDACTED field]"] }, { type: "login", value: ["someone"] }],
	});
});

test("an unterminated private-key header does not make the scan quadratic", () => {
	const input = "-----BEGIN PRIVATE KEY----- ".repeat(20_000);
	const started = performance.now();
	redactText(input, noStore);
	assert.ok(performance.now() - started < 500, "took too long");
});
