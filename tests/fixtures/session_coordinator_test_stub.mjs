function schema(kind, options = {}) {
	return { kind, ...options };
}

export const Type = {
	Object(properties, options = {}) {
		return schema("object", { properties, ...options });
	},
	String(options = {}) {
		return schema("string", options);
	},
	Literal(value) {
		return schema("literal", { value });
	},
	Union(values, options = {}) {
		return schema("union", { values, ...options });
	},
	Optional(value) {
		return { ...value, optional: true };
	},
};
