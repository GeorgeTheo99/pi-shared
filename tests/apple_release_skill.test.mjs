import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = join(root, "skills", "apple-release", "scripts");
const SECRET_ID = "KEYID12345";
const SECRET_ISSUER = "00000000-1111-2222-3333-444444444444";

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "apple-release-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(script, args, env) {
  return spawnSync(join(scripts, script), args, { encoding: "utf8", env: { ...process.env, ...env } });
}

function privateFile(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o600);
  return path;
}

test("configure.sh writes a private config from an App Store Connect env file without printing values", (t) => {
  const dir = sandbox(t);
  const config = join(dir, "cfg", "config.env");
  const key = privateFile(join(dir, "AuthKey.p8"), "not a real key\n");
  const ascEnv = privateFile(join(dir, ".appstoreconnect.env"),
    `APPSTORE_API_KEY_ID=${SECRET_ID}\nAPPSTORE_ISSUER_ID=${SECRET_ISSUER}\nAPPSTORE_API_PRIVATE_KEY_PATH=${key}\nOTHER_SECRET=nope\n`);
  const result = run("configure.sh", ["--team", "ABCDE12345", "--asc-env", ascEnv], { APPLE_RELEASE_CONFIG: config });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout + result.stderr;
  for (const secret of [SECRET_ID, SECRET_ISSUER, "nope"]) assert.ok(!output.includes(secret));
  assert.equal(statSync(config).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(config)).mode & 0o777, 0o700);
  const text = readFileSync(config, "utf8");
  assert.match(text, /^APPLE_TEAM_ID="ABCDE12345"$/m);
  assert.match(text, new RegExp(`^ASC_KEY_ID="${SECRET_ID}"$`, "m"));
  assert.ok(!text.includes("OTHER_SECRET"));

  const update = run("configure.sh", ["--installer-identity", "Developer ID Installer: A B (ABCDE12345)"],
    { APPLE_RELEASE_CONFIG: config });
  assert.equal(update.status, 0, update.stderr);
  const updated = readFileSync(config, "utf8");
  assert.match(updated, /^INSTALLER_IDENTITY="Developer ID Installer: A B \(ABCDE12345\)"$/m);
  assert.equal(updated.match(/^APPLE_TEAM_ID=/gm).length, 1);
});

test("config loading rejects shared files, unknown keys and bad team IDs", (t) => {
  const dir = sandbox(t);
  const config = join(dir, "config.env");
  const load = () => spawnSync("/bin/bash", ["-c", `source "${scripts}/lib.sh"; load_config`],
    { encoding: "utf8", env: { ...process.env, APPLE_RELEASE_CONFIG: config } });

  privateFile(config, 'APPLE_TEAM_ID="ABCDE12345"\n');
  assert.equal(load().status, 0);
  chmodSync(config, 0o644);
  assert.match(load().stderr, /must not be group\/world accessible/);
  privateFile(config, 'APPLE_TEAM_ID="ABCDE12345"\nPATH=/tmp\n');
  assert.match(load().stderr, /unknown key .*: PATH/);
  privateFile(config, 'APPLE_TEAM_ID="$(touch pwned)"\n');
  assert.match(load().stderr, /APPLE_TEAM_ID must be a 10-character team ID/);
});

test("release scripts fail early and clearly without the needed configuration", (t) => {
  const dir = sandbox(t);
  const config = privateFile(join(dir, "config.env"), 'APPLE_TEAM_ID="ABCDE12345"\n');
  const pkg = join(dir, "x.pkg");
  writeFileSync(pkg, "");
  const env = { APPLE_RELEASE_CONFIG: config };
  assert.match(run("release-pkg.sh", [pkg], env).stderr, /SIGNING_KEYCHAIN and SIGNING_KEYCHAIN_PASSWORD_FILE must be set/);
  assert.match(run("notarize.sh", [pkg], env).stderr, /ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID must be set/);
  assert.match(run("notarize.sh", [join(dir, "x.txt")], env).stderr, /artifact not found/);
  assert.match(run("with-signing-keychain.sh", ["true"], env).stderr, /usage: with-signing-keychain.sh/);
  assert.match(run("release-macos-app.sh", ["--scheme", "App"], env).stderr, /--project or --workspace/);
  assert.match(run("verify.sh", [pkg.replace(".pkg", ".txt")], env).stderr, /artifact not found/);
});

test("detect.py classifies SwiftPM, xcodegen and installer projects without building", (t) => {
  const dir = sandbox(t);
  const detect = (path) => JSON.parse(spawnSync("/usr/bin/python3", [join(scripts, "detect.py"), path],
    { encoding: "utf8" }).stdout);

  const tool = join(dir, "tool");
  mkdirSync(tool);
  writeFileSync(join(tool, "Package.swift"),
    'let package = Package(name: "t", targets: [.executableTarget(name: "tool"), .target(name: "Core")])\n');
  assert.deepEqual([detect(tool).kind, detect(tool).executables], ["swiftpm-executable", ["tool"]]);

  const spec = join(dir, "spec");
  mkdirSync(spec);
  writeFileSync(join(spec, "project.yml"), "name: App\n");
  assert.equal(detect(spec).kind, "xcodegen-ungenerated");

  const installer = join(dir, "installer");
  mkdirSync(join(installer, "scripts"), { recursive: true });
  writeFileSync(join(installer, "scripts", "build.sh"), "#!/bin/sh\npkgbuild --root root out.pkg\n");
  mkdirSync(join(installer, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(installer, "node_modules", "dep", "x.sh"), "productbuild\n");
  const result = detect(installer);
  assert.equal(result.kind, "installer-package");
  assert.deepEqual(result.installer_build_scripts, [join(installer, "scripts", "build.sh")]);

  const empty = join(dir, "empty");
  mkdirSync(empty);
  assert.equal(detect(empty).kind, "unknown");
});
