const schema = (...args) => ({ args });
export const Type = new Proxy({}, { get: () => schema });
