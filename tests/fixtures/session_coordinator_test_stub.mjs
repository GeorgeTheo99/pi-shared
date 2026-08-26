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
	Optional(value) {
		return { ...value, optional: true };
	},
};
