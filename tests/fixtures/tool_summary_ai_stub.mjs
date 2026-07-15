export const completeCalls = [];
let implementation = async () => ({
  content: [{ type: "text", text: "default summary" }],
  stopReason: "stop",
});

export function __setCompleteImplementation(next) {
  implementation = next;
}

export function __resetCompleteStub() {
  completeCalls.length = 0;
  implementation = async () => ({
    content: [{ type: "text", text: "default summary" }],
    stopReason: "stop",
  });
}

export async function complete(model, context, options) {
  completeCalls.push({ model, context, options });
  return implementation(model, context, options);
}

export function StringEnum(values, options = {}) {
  return { type: "string", enum: [...values], ...options };
}
