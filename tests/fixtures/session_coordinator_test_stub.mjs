function schema(kind, options = {}) {
	return { kind, type: kind, ...options };
}

export const defineTool = tool => tool;

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
	Number(options = {}) { return schema("number", options); },
	Integer(options = {}) { return schema("integer", options); },
	Array(items, options = {}) { return schema("array", { items, ...options }); },
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
