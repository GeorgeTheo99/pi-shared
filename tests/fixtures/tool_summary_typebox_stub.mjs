function schema(type, options = {}) {
  return { type, ...options };
}

export const Type = {
  Object(properties, options = {}) {
    return { type: "object", properties, ...options };
  },
  String(options = {}) {
    return schema("string", options);
  },
  Number(options = {}) {
    return schema("number", options);
  },
  Boolean(options = {}) {
    return schema("boolean", options);
  },
  Optional(value) {
    return { ...value, optional: true };
  },
};
