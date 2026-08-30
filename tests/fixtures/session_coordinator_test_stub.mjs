function schema(kind, options = {}) {
	return { kind, ...options };
}

export class Text {
	constructor(text, padLeft = 0, padRight = 0) {
		this.text = text;
		this.padLeft = padLeft;
		this.padRight = padRight;
	}
}

export const Type = {
	Object(properties, options = {}) {
		return schema("object", { properties, ...options });
	},
	String(options = {}) {
		return schema("string", options);
	},
	Boolean(options = {}) {
		return schema("boolean", options);
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
