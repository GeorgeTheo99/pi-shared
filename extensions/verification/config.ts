import fs from "node:fs";
import { boundedRead, decode, projectPath, relativePath } from "./files.ts";
import { digest, LIMITS, type VerificationConfig } from "./types.ts";

function object(value: any, keys: string[]): void {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error("Invalid verification config object/unknown field");
}
function strings(value: any, max: number): asserts value is string[] {
	if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== "string" || v.length > 4096 || v.includes("\0"))) throw new Error("Invalid/oversized config string array");
}
export async function loadConfig(cwd: string) {
	const project = fs.realpathSync(cwd);
	const raw = boundedRead(projectPath(project, ".pi/verification.json"), LIMITS.configBytes);
	const config = JSON.parse(decode(raw));
	object(config, ["version", "checks"]);
	if (config.version !== 1 || !Array.isArray(config.checks) || config.checks.length < 1 || config.checks.length > 32) throw new Error("Expected verification config version 1 with 1–32 checks");
	const ids = new Set<string>();
	for (const check of config.checks) {
		object(check, ["id", "command", "args", "cwd", "timeoutSeconds", "inputs", "report", "discovery"]);
		if (Buffer.byteLength(JSON.stringify(check)) > 16384) throw new Error("Individual check exceeds 16 KiB");
		if (typeof check.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(check.id) || ids.has(check.id)) throw new Error("Invalid/duplicate check ID");
		ids.add(check.id);
		if (typeof check.command !== "string" || !check.command || check.command.length > 4096 || /[\x00-\x1f]/.test(check.command)) throw new Error("Invalid executable");
		strings(check.args, 128);
		if (Buffer.byteLength(JSON.stringify(check.args)) > 8192) throw new Error("Check argv exceeds 8 KiB");
		check.cwd = relativePath(check.cwd);
		if (!Number.isFinite(check.timeoutSeconds) || check.timeoutSeconds <= 0 || check.timeoutSeconds > 3600) throw new Error("Check timeoutSeconds must be in (0, 3600]");
		object(check.report, ["format", "path"]);
		if (!["exit", "tap", "junit"].includes(check.report.format)) throw new Error("Unsupported report format");
		if (check.report.format === "exit") {
			if (check.report.path !== undefined || check.discovery !== undefined) throw new Error("Exit checks have no report path/discovery counts");
		} else {
			if (check.report.path !== "stdout") check.report.path = relativePath(check.report.path);
			object(check.discovery, ["allowZero", "minTests"]);
			if (typeof check.discovery.allowZero !== "boolean" || (check.discovery.minTests !== undefined && (!Number.isInteger(check.discovery.minTests) || check.discovery.minTests < 0 || check.discovery.minTests > LIMITS.tests))) throw new Error("Explicit discovery.allowZero and bounded minTests required");
			if (check.report.path !== "stdout" && !check.args.some((arg: string) => arg.includes("{report}"))) throw new Error("File report checks must pass {report} in argv");
		}
		if (check.inputs !== undefined) {
			object(check.inputs, ["paths", "exclude", "untracked"]);
			strings(check.inputs.paths, 128); strings(check.inputs.exclude, 128);
			if (!check.inputs.paths.length || check.inputs.untracked !== "include") throw new Error("Inputs need explicit paths and untracked: include");
			check.inputs.paths = check.inputs.paths.map(relativePath);
			check.inputs.exclude = check.inputs.exclude.map(relativePath);
		}
	}
	return { project, config: config as VerificationConfig, sha256: await digest(raw), text: decode(raw) };
}
