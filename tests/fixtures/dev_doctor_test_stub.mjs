const schema = (...args) => ({ args });
export const Type = { Boolean: schema, Number: schema, Object: schema, Optional: schema, String: schema };
export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
