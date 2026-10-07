export const Type = {
  Boolean: (options = {}) => ({ type: 'boolean', ...options }),
  Number: (options = {}) => ({ type: 'number', ...options }),
  Integer: (options = {}) => ({ type: 'integer', ...options }),
  Object: (properties, options = {}) => ({ type: 'object', properties, ...options }),
  Array: (items, options = {}) => ({ type: 'array', items, ...options }),
  Optional: schema => schema,
  String: (options = {}) => ({ type: 'string', ...options }),
};
export const defineTool = tool => tool;
export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
