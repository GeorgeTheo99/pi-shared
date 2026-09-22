import { validateToolArguments } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

// Pi also coerces primitives (including required nulls) during validation. The
// operation boundary permits only removal of explicitly optional null fields,
// never type changes, inserted values, dropped foreign fields, or array changes.
function onlyOptionalNullsRemoved(before: unknown, after: unknown, schema: any): boolean {
	if (Object.is(before, after)) return true;
	if (Array.isArray(before)) {
		return Array.isArray(after) && before.length === after.length && before.every((value, i) =>
			onlyOptionalNullsRemoved(value, after[i], schema.items ?? {}));
	}
	if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(after)) return false;
	const input = before as Record<string, unknown>;
	const output = after as Record<string, unknown>;
	if (Object.keys(output).some(key => !Object.hasOwn(input, key))) return false;
	return Object.keys(input).every(key => {
		const property = schema.properties?.[key];
		if (!Object.hasOwn(output, key)) return input[key] === null && property !== undefined && !(schema.required ?? []).includes(key);
		return onlyOptionalNullsRemoved(input[key], output[key], property ?? schema.additionalProperties ?? {});
	});
}

/** One schema is the contract for both Pi calls and direct extension callers.
 * Stock Pi normalizes optional nulls; never erase empty arrays or guess a mode.
 * Validate in prepareArguments as well so Pi's default error cannot echo private
 * commands, prompts or answers. Revalidate at execute for direct callers/hooks.
 */
export function operationTool<T extends ToolDefinition<any, any, any>>(definition: T): T {
	const parse = (args: unknown) => {
		try {
			const validated = validateToolArguments(definition, { type: "toolCall", id: "validation", name: definition.name, arguments: args as Record<string, unknown> });
			if (!onlyOptionalNullsRemoved(args, validated, definition.parameters)) throw new Error("Argument coercion is not allowed");
			return validated;
		} catch {
			const required = definition.parameters.required ?? [];
			const allowed = Object.keys(definition.parameters.properties ?? {});
			throw new Error(`Invalid arguments for ${definition.name}. Required fields: ${required.join(", ") || "none"}. Allowed fields: ${allowed.join(", ") || "none"}. Check field types and bounds; omit fields belonging to other operations.`);
		}
	};
	return {
		...definition,
		prepareArguments: parse,
		async execute(id, args, signal, update, ctx) {
			return definition.execute(id, parse(args), signal, update, ctx);
		},
	};
}
