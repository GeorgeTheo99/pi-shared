import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UNSUPPORTED_NUMBER_BOUNDS = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_NODES = new Set(["items", "additionalProperties", "not", "if", "then", "else"]);

function withoutNumberBounds(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;

  const schema = value as Record<string, unknown>;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const numeric = types.includes("number") || types.includes("integer") || schema.type === undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (numeric && UNSUPPORTED_NUMBER_BOUNDS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      result[key] = Object.fromEntries(Object.entries(child).map(([name, nested]) => [name, withoutNumberBounds(nested)]));
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(child)) {
      result[key] = child.map(withoutNumberBounds);
    } else if (SCHEMA_NODES.has(key)) {
      result[key] = withoutNumberBounds(child);
    } else {
      result[key] = child;
    }
  }
  return result;
}

/** Anthropic rejects numeric bounds in tool input schemas; Pi still validates the original schema locally. */
export default function anthropicSchema(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "anthropic" || !event.payload || typeof event.payload !== "object") return;
    const payload = event.payload as Record<string, unknown>;
    if (!Array.isArray(payload.tools)) return;
    return {
      ...payload,
      tools: payload.tools.map((tool: unknown) => {
        if (!tool || typeof tool !== "object" || !("input_schema" in tool)) return tool;
        const original = tool as Record<string, unknown>;
        return { ...original, input_schema: withoutNumberBounds(original.input_schema) };
      }),
    };
  });
}
