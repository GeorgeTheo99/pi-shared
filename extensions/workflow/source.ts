import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_INLINE_WORKFLOW_CHARS = 20_000;
export const MAX_WORKFLOW_FILE_BYTES = 1024 * 1024;

export type WorkflowSourceKind = "inline" | "saved" | "path";

export interface ReadyWorkflowSource {
	kind: "ready";
	code: string;
	source: WorkflowSourceKind;
	name?: string;
	scriptPath?: string;
}

export interface WorkflowSourceApproval {
	kind: "approval";
	source: Exclude<WorkflowSourceKind, "inline">;
	name?: string;
	scriptPath: string;
	reason: "project" | "external";
}

export interface WorkflowSourceError {
	kind: "error";
	error: string;
}

export type WorkflowSourceResolution = ReadyWorkflowSource | WorkflowSourceApproval | WorkflowSourceError;

export interface ResolveWorkflowSourceOptions {
	params: { script?: unknown; name?: unknown; scriptPath?: unknown };
	cwd: string;
	sharedDir: string;
	projectDir: string | null;
	projectTrusted: boolean;
	allowedScriptDirs?: string[];
}

function expandTilde(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

function canonicalExistingFile(filePath: string): { ok: true; path: string } | { ok: false; error: string } {
	let canonical: string;
	try {
		canonical = fs.realpathSync.native(filePath);
	} catch (error: unknown) {
		return { ok: false, error: `Workflow file not found: ${filePath} (${error instanceof Error ? error.message : String(error)})` };
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(canonical);
	} catch (error: unknown) {
		return { ok: false, error: `Could not stat workflow file ${canonical}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!stat.isFile()) return { ok: false, error: `Workflow source is not a regular file: ${canonical}` };
	if (path.extname(canonical).toLowerCase() !== ".js") return { ok: false, error: `Workflow source must be a .js file: ${canonical}` };
	if (stat.size > MAX_WORKFLOW_FILE_BYTES) {
		return { ok: false, error: `Workflow file is ${stat.size} bytes; max is ${MAX_WORKFLOW_FILE_BYTES}: ${canonical}` };
	}
	return { ok: true, path: canonical };
}

function canonicalDirectory(dir: string): string {
	const resolved = path.resolve(expandTilde(dir));
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

export function pathIsWithin(filePath: string, directory: string): boolean {
	const relative = path.relative(directory, filePath);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function readReadyFile(
	filePath: string,
	source: Exclude<WorkflowSourceKind, "inline">,
	name?: string,
): ReadyWorkflowSource | WorkflowSourceError {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) return { kind: "error", error: `Workflow source is not a regular file: ${filePath}` };
		if (stat.size > MAX_WORKFLOW_FILE_BYTES) {
			return { kind: "error", error: `Workflow file is ${stat.size} bytes; max is ${MAX_WORKFLOW_FILE_BYTES}: ${filePath}` };
		}
		return { kind: "ready", code: fs.readFileSync(descriptor, "utf8"), source, name, scriptPath: filePath };
	} catch (error: unknown) {
		return { kind: "error", error: `Could not read workflow file ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function classifyFile(
	filePath: string,
	source: Exclude<WorkflowSourceKind, "inline">,
	name: string | undefined,
	options: ResolveWorkflowSourceOptions,
): WorkflowSourceResolution {
	const canonical = canonicalExistingFile(filePath);
	if (!canonical.ok) return { kind: "error", error: canonical.error };
	const sharedDir = canonicalDirectory(options.sharedDir);
	if (pathIsWithin(canonical.path, sharedDir)) return readReadyFile(canonical.path, source, name);

	const projectDir = options.projectDir ? canonicalDirectory(options.projectDir) : null;
	const projectRoot = projectDir ? path.dirname(path.dirname(projectDir)) : canonicalDirectory(options.cwd);
	if (pathIsWithin(canonical.path, projectRoot)) {
		if (options.projectTrusted) return readReadyFile(canonical.path, source, name);
		return { kind: "approval", source, name, scriptPath: canonical.path, reason: "project" };
	}

	const allowed = (options.allowedScriptDirs ?? []).map(canonicalDirectory);
	if (allowed.some((directory) => pathIsWithin(canonical.path, directory))) {
		return readReadyFile(canonical.path, source, name);
	}
	return { kind: "approval", source, name, scriptPath: canonical.path, reason: "external" };
}

export function resolveWorkflowSource(options: ResolveWorkflowSourceOptions): WorkflowSourceResolution {
	const { params } = options;
	const hasScript = typeof params.script === "string" && params.script.trim().length > 0;
	const hasName = typeof params.name === "string" && params.name.trim().length > 0;
	const hasPath = typeof params.scriptPath === "string" && params.scriptPath.trim().length > 0;
	if (Number(hasScript) + Number(hasName) + Number(hasPath) !== 1) {
		return { kind: "error", error: "Provide exactly one of `script` (inline JS), `name` (saved workflow), or `scriptPath` (workflow file path)." };
	}

	if (hasScript) {
		const code = params.script as string;
		if (code.length > MAX_INLINE_WORKFLOW_CHARS) {
			return { kind: "error", error: `Inline script is ${code.length} chars; max is ${MAX_INLINE_WORKFLOW_CHARS}. Use scriptPath or a saved workflow.` };
		}
		return { kind: "ready", code, source: "inline" };
	}

	if (hasPath) {
		const input = expandTilde((params.scriptPath as string).trim());
		const filePath = path.isAbsolute(input) ? input : path.resolve(options.cwd, input);
		return classifyFile(filePath, "path", undefined, options);
	}

	const name = (params.name as string).trim();
	if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
		return { kind: "error", error: `Invalid workflow name: ${JSON.stringify(name)}.` };
	}
	const sharedPath = path.join(options.sharedDir, `${name}.js`);
	if (fs.existsSync(sharedPath)) return classifyFile(sharedPath, "saved", name, options);
	if (options.projectDir) {
		const projectPath = path.join(options.projectDir, `${name}.js`);
		if (fs.existsSync(projectPath)) return classifyFile(projectPath, "saved", name, options);
	}
	const lookedIn = [options.sharedDir, options.projectDir].filter(Boolean).map((dir) => `- ${dir}`).join("\n");
	return { kind: "error", error: `Saved workflow "${name}" not found. Looked in:\n${lookedIn || "(no workflow dirs found)"}` };
}

export function approveWorkflowSource(request: WorkflowSourceApproval): ReadyWorkflowSource | WorkflowSourceError {
	const canonical = canonicalExistingFile(request.scriptPath);
	if (!canonical.ok) return { kind: "error", error: canonical.error };
	if (canonical.path !== request.scriptPath) {
		return {
			kind: "error",
			error: `Workflow source target changed after approval was requested: ${request.scriptPath}`,
		};
	}
	return readReadyFile(canonical.path, request.source, request.name);
}

export function configuredWorkflowScriptDirs(env: NodeJS.ProcessEnv = process.env): string[] {
	return (env.PI_WORKFLOW_ALLOWED_SCRIPT_DIRS ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}
