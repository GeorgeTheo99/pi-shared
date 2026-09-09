import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppTestRuntime, LIMITS } from "./app-test-runtime.ts";

export default function (pi: ExtensionAPI) {
	let runtime: AppTestRuntime | undefined;
	const reset = async () => { const previous = runtime; runtime = undefined; await previous?.dispose(); };
	pi.on("session_switch", reset);
	pi.on("session_fork", reset);
	pi.on("session_shutdown", reset);
	pi.registerTool(defineTool({
		name: "app_test",
		label: "App test",
		description: "Reproducible local/private app tests in a fresh session-owned context, separate from authenticated app_*. Create desktop/mobile, configure viewport, accessibility snapshot, run explicit steps, close, opt-in trace_start/trace_stop. Stops at the first failure; no mutation replay. Context IDs cannot cross Pi sessions. Failure evidence and traces are private and deleted on close/15-minute expiry/shutdown. Trace recording stops after 60s; retained output size checks are not hard disk quotas. Not a public-browser fallback.",
		parameters: Type.Object({
			action: StringEnum(["create", "close", "configure", "snapshot", "run", "trace_start", "trace_stop"]),
			contextId: Type.Optional(Type.String({ maxLength: 128 })),
			device: Type.Optional(StringEnum(["desktop", "mobile"], { description: "Emulation fixed at create; configure only resizes viewport" })),
			width: Type.Optional(Type.Integer({ minimum: 240, maximum: 1920 })),
			height: Type.Optional(Type.Integer({ minimum: 240, maximum: 1920 })),
			steps: Type.Optional(Type.Array(Type.Object({
				action: StringEnum(["goto", "click", "fill", "press", "wait_visible", "assert_visible", "assert_text", "assert_url"]),
				selector: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
				value: Type.Optional(Type.String({ maxLength: 4096, description: "URL, fill text, key, or exact expected text/URL" })),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.timeoutMs })),
			}, { additionalProperties: false }), { minItems: 1, maxItems: LIMITS.steps })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			runtime ??= new AppTestRuntime();
			const result = await runtime.execute(ctx.sessionManager.getSessionId(), params, signal);
			// Pi marks thrown errors as tool failures; keep first-failure evidence in the error text.
			if (result.ok === false) throw new Error(JSON.stringify(result));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	}));
}
