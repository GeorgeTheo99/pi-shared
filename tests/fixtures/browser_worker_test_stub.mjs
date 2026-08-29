function schema(type, options = {}) {
  return { type, ...options };
}

export function StringEnum(values, options = {}) {
  return { type: "string", enum: [...values], ...options };
}

export const Type = {
  Any: (options = {}) => options,
  Boolean: (options = {}) => schema("boolean", options),
  Integer: (options = {}) => schema("integer", options),
  Literal: (value) => ({ const: value }),
  Object: (properties, options = {}) => schema("object", { properties, ...options }),
  Optional: (value) => ({ ...value, optional: true }),
  String: (options = {}) => schema("string", options),
  Union: (anyOf, options = {}) => ({ anyOf, ...options }),
};

export function defineTool(tool) {
  return tool;
}
