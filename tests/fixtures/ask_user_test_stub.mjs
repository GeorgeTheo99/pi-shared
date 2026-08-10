const schema = (...args) => ({ args });

export const Type = {
  Array: schema,
  Boolean: schema,
  Number: schema,
  Object: schema,
  Optional: schema,
  String: schema,
};

export function defineTool(tool) {
  return tool;
}

export class Text {
  constructor(text) {
    this.text = text;
  }
}
