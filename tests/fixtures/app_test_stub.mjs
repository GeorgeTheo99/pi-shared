export const Type = {
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Optional: schema => ({ ...schema, optional: true }),
  String: (options = {}) => ({ type: "string", ...options }),
  Integer: (options = {}) => ({ type: "integer", ...options }),
};
export const StringEnum = (values, options = {}) => ({ type: "string", enum: values, ...options });
export const defineTool = tool => tool;
