import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const UNSUPPORTED_CONSTRAINTS: Record<string, Set<string>> = {
  number: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
  integer: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
  array: new Set(["minItems", "maxItems", "uniqueItems"]),
  string: new Set(["minLength", "maxLength", "pattern", "format"]),
  object: new Set(["minProperties", "maxProperties"]),
};

const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions"]);
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SCHEMA_NODES = new Set(["items", "additionalProperties", "contains", "not", "if", "then", "else"]);

function withoutStrictNullability(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...schema };
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    result.properties = Object.fromEntries(Object.entries(properties).map(([name, property]) => {
      const candidate = property as Record<string, unknown>;
      const variants = candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate.anyOf : undefined;
      const generated = Array.isArray(variants) && variants.length === 2 && Object.keys(candidate).length === 1
        && variants[1] && typeof variants[1] === "object" && !Array.isArray(variants[1])
        && Object.keys(variants[1]).length === 1 && variants[1].type === "null";
      // A required nullable anyOf can look identical; local validation still
      // enforces its original requiredness if the model omits it.
      if (generated) required.delete(name);
      return [name, withoutStrictNullability(generated ? variants[0] : property)];
    }));
    if (Array.isArray(schema.required)) result.required = [...required];
  }
  for (const key of SCHEMA_LISTS) {
    if (Array.isArray(schema[key])) result[key] = schema[key].map(withoutStrictNullability);
  }
  for (const key of SCHEMA_NODES) {
    if (key !== "items" || !Array.isArray(schema[key])) {
      if (schema[key] !== undefined) result[key] = withoutStrictNullability(schema[key]);
    } else result[key] = schema[key].map(withoutStrictNullability);
  }
  return result;
}

function withoutUnsupportedConstraints(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;

  const schema = value as Record<string, unknown>;
  const types = Array.isArray(schema.type) ? schema.type : schema.type === undefined
    ? Object.keys(UNSUPPORTED_CONSTRAINTS) : [schema.type];
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (types.some((type) => typeof type === "string" && UNSUPPORTED_CONSTRAINTS[type]?.has(key))) continue;
    if (SCHEMA_MAPS.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      result[key] = Object.fromEntries(Object.entries(child).map(([name, nested]) => [name, withoutUnsupportedConstraints(nested)]));
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(child)) {
      result[key] = child.map(withoutUnsupportedConstraints);
    } else if (SCHEMA_NODES.has(key)) {
      result[key] = Array.isArray(child) ? child.map(withoutUnsupportedConstraints) : withoutUnsupportedConstraints(child);
    } else {
      result[key] = child;
    }
  }
  return result;
}

/** Anthropic rejects some schema constraints and caps strict-schema unions; Pi validates locally. */
export default function anthropicSchema(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "anthropic" || !event.payload || typeof event.payload !== "object") return;
    const payload = event.payload as Record<string, unknown>;
    if (!Array.isArray(payload.tools)) return;
    return {
      ...payload,
      tools: payload.tools.map((tool: unknown) => {
        if (!tool || typeof tool !== "object" || !("input_schema" in tool)) return tool;
        const outgoing = tool as Record<string, unknown>;
        // Pi's strict conversion makes optional fields required nullable unions.
        // Restore optionality from that specific wrapper before disabling strict
        // sampling; substituting current registry schemas would corrupt resumed
        // transcripts whose same-named tools have different definitions.
        const { strict: _strict, ...nonStrict } = outgoing;
        const schema = outgoing.strict === true
          ? withoutStrictNullability(outgoing.input_schema) : outgoing.input_schema;
        return { ...nonStrict, input_schema: withoutUnsupportedConstraints(schema) };
      }),
    };
  });
}
