const schema = (...args) => ({ args });

export const Type = {
  Literal: schema,
  Number: schema,
  Object: schema,
  Optional: schema,
  String: schema,
  Union: schema,
};
