const schema = (...args) => ({ args });
export const Type = new Proxy({}, { get: () => schema });
export const StringEnum = (values, options = {}) => ({ type: "string", enum: values, ...options });
