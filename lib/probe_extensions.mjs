// Loaded by bin/pi-profile-check through the installed Pi SDK. No session,
// model prompt, shell startup, package update, or profile repair is run.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const safeReport = args.at(-1) === "--safe-report";
if (safeReport) args.pop();
const [sdkPath, agentDir, cwd, reportPath, ...expectedPackages] = args;
let report = { ok: false, errors: [], extensions: [] };
try {
  const { DefaultResourceLoader, SettingsManager } = await import(pathToFileURL(sdkPath).href);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
  await loader.reload();
  const result = loader.getExtensions();
  report.errors = result.errors.map(({ path: source, error }) => `${source}: ${error}`);
  report.errors.push(...settingsManager.drainErrors().map(({ error }) => String(error)));
  report.extensions = result.extensions.map((extension) => extension.resolvedPath ?? extension.path);
  const seenTools = new Map();
  for (const extension of result.extensions) {
    for (const name of extension.tools.keys()) {
      if (seenTools.has(name)) report.errors.push(`Duplicate tool ${name}: ${seenTools.get(name)} and ${extension.path}`);
      seenTools.set(name, extension.path);
    }
  }
  for (const expected of expectedPackages) {
    const root = fs.realpathSync(expected) + path.sep;
    if (!report.extensions.some((source) => typeof source === "string" && fs.realpathSync(source).startsWith(root))) {
      report.errors.push(`No extensions loaded from required package ${expected}; check ${agentDir}/settings.json`);
    }
  }
  report.ok = report.errors.length === 0;
} catch (error) {
  report.errors.push(String(error));
}
if (safeReport) {
  // Extension errors and paths can contain credentials. Do not persist them in
  // structured doctor reports, even on failed imports.
  report = { ok: report.ok, extension_count: report.extensions.length,
    errors: report.ok ? [] : ["Extension import/registration verification failed; inspect trusted code locally"] };
}
fs.writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
// Extensions may leave timers running during registration. Exit only after
// writing the explicit result; the Python caller also enforces a deadline.
process.exit(report.ok ? 0 : 1);
