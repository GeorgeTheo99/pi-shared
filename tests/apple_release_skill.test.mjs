import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function run(script, args, env, cwd) {
  return spawnSync(join(scripts, script), args, { encoding: "utf8", cwd, env: { ...process.env, ...env } });
}

// Put fake tools first on PATH; each logs its argv to calls.log in the shim dir.
function shims(dir, tools) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${bin}/calls.log"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { PATH: `${bin}:${process.env.PATH}`, calls: () => readFileSync(join(bin, "calls.log"), "utf8") };
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
  const load = () => spawnSync("/bin/bash", ["-c", `source "${scripts}/lib.sh"; load_config; env`],
    { encoding: "utf8", cwd: dir, env: { ...process.env, APPLE_RELEASE_CONFIG: config } });

  privateFile(config, 'APPLE_TEAM_ID="ABCDE12345"\nASC_KEY_ID="KEYID"\n');
  const loaded = load();
  assert.equal(loaded.status, 0);
  assert.ok(!/^ASC_KEY_ID=/m.test(loaded.stdout), "config values must not be exported to child processes");
  chmodSync(config, 0o644);
  assert.match(load().stderr, /must not be group\/world accessible/);
  privateFile(config, 'APPLE_TEAM_ID="ABCDE12345"\nPATH=/tmp\n');
  assert.match(load().stderr, /unknown key .*: PATH/);
  privateFile(config, 'APPLE_TEAM_ID="$(touch pwned)"\n');
  assert.match(load().stderr, /APPLE_TEAM_ID must be a 10-character team ID/);
  assert.ok(!existsSync(join(dir, "pwned")));
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

test("configure.sh accepts sourced-shell quoting and $HOME paths in the App Store Connect env file", (t) => {
  const dir = sandbox(t);
  const home = join(dir, "home");
  mkdirSync(home);
  privateFile(join(home, "AuthKey.p8"), "k\n");
  const ascEnv = privateFile(join(dir, "asc.env"),
    "export APPSTORE_API_KEY_ID='KEYID12345'\nAPPSTORE_ISSUER_ID=\"issuer\"\nAPPSTORE_API_PRIVATE_KEY_PATH=$HOME/AuthKey.p8\n");
  const config = join(dir, "cfg", "config.env");
  const result = run("configure.sh", ["--team", "ABCDE12345", "--asc-env", ascEnv],
    { APPLE_RELEASE_CONFIG: config, HOME: home });
  assert.equal(result.status, 0, result.stderr);
  const text = readFileSync(config, "utf8");
  assert.match(text, /^ASC_KEY_ID="KEYID12345"$/m);
  assert.match(text, new RegExp(`^ASC_KEY_PATH="${join(home, "AuthKey.p8")}"$`, "m"));
});

function keychainSandbox(t) {
  const dir = sandbox(t);
  const keychain = join(dir, "signing.keychain-db");
  const password = privateFile(join(dir, "password"), "rehearsal-password\n");
  spawnSync("/usr/bin/security", ["create-keychain", "-p", "rehearsal-password", keychain]);
  t.after(() => spawnSync("/usr/bin/security", ["delete-keychain", keychain]));
  const config = privateFile(join(dir, "config.env"),
    `APPLE_TEAM_ID="ABCDE12345"\nSIGNING_KEYCHAIN="${keychain}"\nSIGNING_KEYCHAIN_PASSWORD_FILE="${password}"\n`);
  return { dir, keychain, config };
}

// Fake search list (never touches the real one); lock/unlock use the real keychain.
const fakeSearchList = (failRestore) => `
if [ "$1" = list-keychains ]; then
  if [ "$4" = -s ]; then
    n=$(grep -c ' -s ' "$(dirname "$0")/calls.log")
    ${failRestore ? '[ "$n" -lt 2 ] || exit 1' : ":"}
    exit 0
  fi
  echo '    "/fake/login.keychain-db"'; exit 0
fi
exec /usr/bin/security "$@"`;

test("with-signing-keychain.sh restores the search list and always relocks", (t) => {
  for (const [command, status] of [["true", 0], ["false", 1]]) {
    const { dir, keychain, config } = keychainSandbox(t);
    const tools = shims(dir, { security: fakeSearchList(false) });
    const result = run("with-signing-keychain.sh", ["--search-list", "--", command],
      { APPLE_RELEASE_CONFIG: config, PATH: tools.PATH });
    assert.equal(result.status, status, result.stderr);
    const calls = tools.calls().split("\n").filter(Boolean);
    const setCalls = calls.filter((line) => line.includes("list-keychains -d user -s"));
    assert.deepEqual(setCalls, [`security list-keychains -d user -s ${keychain} /fake/login.keychain-db`,
      "security list-keychains -d user -s /fake/login.keychain-db"]);
    assert.ok(calls.indexOf(`security lock-keychain ${keychain}`) < calls.indexOf(setCalls[1]));
  }
});

test("with-signing-keychain.sh still locks when restoring the search list fails", (t) => {
  const { dir, keychain, config } = keychainSandbox(t);
  const tools = shims(dir, { security: fakeSearchList(true) });
  const result = run("with-signing-keychain.sh", ["--search-list", "--", "true"],
    { APPLE_RELEASE_CONFIG: config, PATH: tools.PATH });
  assert.notEqual(result.status, 0);
  assert.match(tools.calls(), new RegExp(`security lock-keychain ${keychain}`));
  const info = spawnSync("/usr/bin/security", ["show-keychain-info", keychain], { encoding: "utf8" });
  assert.notEqual(info.status, 0, "keychain must be locked");
});

test("with-signing-keychain.sh waits for a concurrent holder of the keychain lock", async (t) => {
  const { dir, config } = keychainSandbox(t);
  const holder = spawn("/usr/bin/lockf", ["-k", join(dir, ".keychain.lock"), "sleep", "2"]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  const result = run("with-signing-keychain.sh", ["--", "true"], { APPLE_RELEASE_CONFIG: config });
  await once(holder, "exit");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started >= 1200, "the run must wait for the lock holder");
});

test("with-signing-keychain.sh relocks and releases its lock when terminated", async (t) => {
  const { dir, keychain, config } = keychainSandbox(t);
  const child = spawn(join(scripts, "with-signing-keychain.sh"), ["--", "sleep", "1"],
    { env: { ...process.env, APPLE_RELEASE_CONFIG: config } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.ok(code !== 0 || signal, "a terminated run must not report success");
  assert.notEqual(spawnSync("/usr/bin/security", ["show-keychain-info", keychain]).status, 0, "keychain must be locked");
  assert.equal(spawnSync("/usr/bin/lockf", ["-s", "-t", "0", join(dir, ".keychain.lock"), "true"]).status, 0,
    "the lock must be released");
});

function notarySandbox(t, status) {
  const dir = sandbox(t);
  const key = privateFile(join(dir, "AuthKey.p8"), "k\n");
  const config = privateFile(join(dir, "config.env"),
    `APPLE_TEAM_ID="ABCDE12345"\nASC_KEY_PATH="${key}"\nASC_KEY_ID="KEYID12345"\nASC_ISSUER_ID="issuer"\n`);
  const tools = shims(dir, {
    xcrun: `case "$1 $2" in
  "notarytool submit") echo '{"id":"sub-1","status":"${status}"}'; [ "${status}" = Accepted ] ;;
  "notarytool log") for last; do :; done; echo '{"issues":[]}' > "$last" ;;
esac`,
  });
  const pkg = join(dir, "App.pkg");
  writeFileSync(pkg, "pkg");
  return { config, tools, pkg };
}

test("notarize.sh staples only accepted submissions and saves Apple's log on rejection", (t) => {
  const accepted = notarySandbox(t, "Accepted");
  const ok = run("notarize.sh", [accepted.pkg], { APPLE_RELEASE_CONFIG: accepted.config, PATH: accepted.tools.PATH });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(accepted.tools.calls(), /xcrun stapler staple .*App\.pkg/);
  assert.match(accepted.tools.calls(), /--wait --timeout 2h/);
  assert.ok(!ok.stderr.includes("KEYID12345"));

  const rejected = notarySandbox(t, "Invalid");
  const bad = run("notarize.sh", [rejected.pkg], { APPLE_RELEASE_CONFIG: rejected.config, PATH: rejected.tools.PATH });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /notarization was not accepted/);
  assert.ok(existsSync(`${rejected.pkg}.notary-log.json`));
  assert.doesNotMatch(rejected.tools.calls(), /stapler/);
});

test("verify.sh requires Apple's notarized Developer ID verdict, not just an accepting exit status", (t) => {
  for (const [source, status] of [["Notarized Developer ID", 0], ["Developer ID", 1]]) {
    const dir = sandbox(t);
    const tools = shims(dir, {
      pkgutil: 'echo "   1. Developer ID Installer: A B (ABCDE12345)"',
      spctl: `echo "x: accepted"; echo "source=${source}"`,
      xcrun: "exit 0",
    });
    const pkg = join(dir, "App.pkg");
    writeFileSync(pkg, "pkg");
    const result = run("verify.sh", [pkg], { PATH: tools.PATH });
    assert.equal(result.status, status, result.stdout + result.stderr);
  }
});
