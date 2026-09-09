// Schema construction only; production uses Pi's bundled TypeBox. Engine validation is real.
export const Type = {
	Object: properties => ({ type: "object", properties }),
	String: options => ({ type: "string", ...options }),
	Optional: schema => ({ ...schema, optional: true }),
};
