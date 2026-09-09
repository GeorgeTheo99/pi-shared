import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodeIntelService } from "./service.ts";

export default function codeIntel(pi: ExtensionAPI) {
  const service = new CodeIntelService();
  pi.on("session_shutdown", async () => { await service.close(); });
  pi.registerTool({
    name: "code_intel",
    label: "Code intelligence",
    description: "Read-only TypeScript/JavaScript status, definition, references, hover, and per-file syntax/semantic diagnostics. Requires trusted .pi/code-intel.json and an installed server; never installs or edits. Paths are workspace-relative; lines/columns are 1-based Unicode code points (ranges end-exclusive). Fresh server per query, bounded on-disk source identity; editor-only buffers/dependencies are outside freshness proof. status checks configuration, not server readiness. At most 1000 locations/diagnostics and 48 KiB results; excess is an explicit error.",
    parameters: Type.Object({
      action: StringEnum(["status", "definition", "references", "hover", "diagnostics"]),
      path: Type.Optional(Type.String({ description: "TS/JS file within configured workspace; required except for status" })),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line, required for definition/references/hover" })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based Unicode code-point column" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      // Old Pi versions without session-aware trust must fail closed.
      const details = await service.run(ctx.cwd, typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(), params, signal);
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    },
  });
}
