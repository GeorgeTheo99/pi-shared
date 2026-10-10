export const Type = {
  Object: (properties, options = {}) => ({ type: "object", properties, ...options }),
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  Optional: schema => ({ ...schema, optional: true }),
  String: (options = {}) => ({ type: "string", ...options }),
  Integer: (options = {}) => ({ type: "integer", ...options }),
};
export const StringEnum = (values, options = {}) => ({ type: "string", enum: values, ...options });
export const defineTool = tool => tool;
Type.Number = (options = {}) => ({ type: "number", ...options });
Type.Boolean = (options = {}) => ({ type: "boolean", ...options });
Type.Unknown = (options = {}) => ({ ...options });
Type.Record = (key, value, options = {}) => ({ type: "object", additionalProperties: value, ...options });
export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const formatSize = bytes => `${bytes}B`;
export const truncateHead = (content, { maxBytes }) => {
  const truncated = Buffer.byteLength(content) > maxBytes;
  const text = truncated ? content.slice(0, maxBytes) : content;
  return { content: text, truncated, outputLines: text.split("\n").length, totalLines: content.split("\n").length, outputBytes: Buffer.byteLength(text), totalBytes: Buffer.byteLength(content) };
};
