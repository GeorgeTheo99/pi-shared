// Lightweight schema fixture for engine unit tests. Provider conversion and
// actual SDK validation are covered separately by job_tools_contract.test.mts.
const optional = Symbol('optional');
export const Type = {
 String: (options = {}) => ({ type: 'string', ...options }),
 Number: (options = {}) => ({ type: 'number', ...options }),
 Integer: (options = {}) => ({ type: 'integer', ...options }),
 Boolean: (options = {}) => ({ type: 'boolean', ...options }),
 Unknown: (options = {}) => ({ ...options }),
 Optional: (schema) => ({ ...schema, [optional]: true }),
 Array: (items, options = {}) => ({ type: 'array', items, ...options }),
 Record: (_keys, values, options = {}) => ({ type: 'object', additionalProperties: values, ...options }),
 Object: (properties, options = {}) => ({ type: 'object', properties, required: Object.keys(properties).filter(key => !properties[key][optional]), ...options }),
};
export const StringEnum = (values, options = {}) => ({ type: 'string', enum: values, ...options });

export function validateToolArguments(tool, call) {
 const args = structuredClone(call.arguments);
 function check(schema, value) {
  if (schema.enum && !schema.enum.includes(value)) throw new Error('enum');
  switch (schema.type) {
   case 'object':
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
    for (const key of Object.keys(value)) {
     const property = schema.properties?.[key];
     if (property) {
      if (value[key] === null && !(schema.required ?? []).includes(key)) { delete value[key]; continue; }
      if (value[key] !== undefined) check(property, value[key]);
     } else if (schema.additionalProperties === false) throw new Error('foreign field');
     else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, value[key]);
    }
    for (const key of schema.required ?? []) if (value[key] === undefined) throw new Error('required');
    break;
   case 'array':
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) throw new Error('array');
    value.forEach(item => check(schema.items, item)); break;
   case 'string':
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new Error('string');
    break;
   case 'integer': if (!Number.isInteger(value)) throw new Error('integer'); // falls through
   case 'number':
    if (typeof value !== 'number' || !Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) || (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)) throw new Error('number');
    break;
   case 'boolean': if (typeof value !== 'boolean') throw new Error('boolean');
  }
 }
 check(tool.parameters, args);
 return args;
}
