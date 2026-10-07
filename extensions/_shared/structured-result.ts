import type { TSchema } from "typebox";

export type ResultStatus = "ok" | "error" | "aborted";

/** Closed, versioned transport envelope. `ok` describes the operation, not job success. */
export function resultSchema(data: TSchema): TSchema {
	return {
		type: "object", additionalProperties: false, required: ["version", "status", "data"],
		properties: {
			version: { type: "integer", const: 1 },
			status: { type: "string", enum: ["ok", "error", "aborted"] },
			data,
		},
	} as TSchema;
}

/** Project only declared fields, recursively. Never publish arbitrary renderer details. */
function project(schema: any, value: any): any {
	if (value === undefined || value === null) return value;
	if (schema.type === "array") return value.map((item: unknown) => project(schema.items, item));
	if (schema.type === "object") {
		return Object.fromEntries(Object.entries(schema.properties ?? {})
			.filter(([key]) => Object.hasOwn(value, key) && value[key] !== undefined)
			.map(([key, child]) => [key, project(child, value[key])]));
	}
	return value;
}

/** Additive on older Pi (which ignores these fields); exceptions/abort paths are not caught.
 * Schemas describe final results only, not streamed progress. Callers must inspect status
 * even when Pi resolves an isError result with structuredContent in codemode.
 */
export function structuredTool<T extends { execute: (...args: any[]) => Promise<any> }>(
	tool: T,
	dataSchema: TSchema,
	select: (result: Awaited<ReturnType<T["execute"]>>, args: any) => { data: unknown; status?: ResultStatus },
): T & { outputSchema: TSchema } {
	return {
		...tool,
		outputSchema: resultSchema(dataSchema),
		async execute(...args: Parameters<T["execute"]>) {
			const result = await tool.execute(...args);
			const selected = select(result, args[1]);
			return { ...result, structuredContent: {
				version: 1, status: result.isError ? "error" : selected.status ?? "ok",
				data: project(dataSchema, selected.data),
			} };
		},
	};
}
