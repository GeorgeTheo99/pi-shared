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
