export type AssistantLike = {
  role: "assistant";
  stopReason?: string;
  content?: Array<{ type?: string; text?: string }>;
};

export function latestAssistantMessage(messages: unknown): AssistantLike | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown } | undefined;
    if (message?.role === "assistant") return message as AssistantLike;
  }
  return undefined;
}
