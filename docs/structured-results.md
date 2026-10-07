# Structured tool results for codemode

Priority pi-shared tools expose both a tool-level `outputSchema` and a final
`structuredContent` value on Pi 0.99+. Codemode can consume these values directly,
without parsing human-readable text. Existing text, renderer `details`, input
schemas, trust checks and blocking behavior are retained. Older Pi versions can
continue using text results; structured script returns require the newer runtime.

## Contract

```ts
{
  version: 1,
  status: "ok" | "error" | "aborted",
  data: { /* tool-specific fields described by outputSchema */ }
}
```

`status` describes the requested operation, **not success of the underlying job**.
Reading a failed job can succeed with `status: "ok"`; inspect `data.job.status`,
its exit code and cleanup separately. A wait reaching its terminal condition does
not mean all jobs passed. A doctor inspection does not certify service readiness.
A schema-valid verification report can still contain a failing verdict.

Some failures still throw, including invalid arguments, authorization failures,
missing jobs and cancellation paths that already threw. Codemode rejects those
calls. Pi 0.99 can resolve `isError` results when they contain structured output;
always check the explicit envelope status as well as domain outcomes. Do not
convert exceptions, missing data or unknown states into successful empty results.

## Covered tools

| Tools | Selected data |
| --- | --- |
| `command_start`, `command_status`, `command_list`, `command_cancel` | Job lifecycle, readiness, exit and cleanup evidence; no command argv or environment |
| `subagent_status`, `subagent_list` | Bounded job summaries, status results and clarification state; no raw child transcripts |
| `wait_for_condition`, `wait_for_jobs`, `wait_for_ready` | Whether the wait condition was met, elapsed time and applicable job snapshots |
| `memory_read` | Memories matching the requested mode and bounded project identity |
| `kb_search` | Search results with source identifiers, citations and availability evidence |
| `web_search` | Results and explicit search outcome; not private broker configuration |
| `peer_sessions` | Bounded advisory peer metadata; not authentication or permission |
| `verify` | Check inventory and verdict evidence; not executable argv |
| `dev_doctor` | Inspection outcomes, capability evidence and MCP registration inventory |

Other tools retain their existing contracts. In particular, the subagent **input**
parameter `outputSchema` validates a child's final JSON; it is not a declaration
of the parent tool's script return type. This release does not replace the
subagent execution engine or remove `subagent_chain`/`workflow`.

Example (read-only; does not wait or cancel):

```js
const result = await tools.command_list({});
if (result.status !== "ok") throw new Error("Could not inspect command jobs");
return result.data.jobs
  .filter(job => ["failed", "timed_out", "lost", "canceled"].includes(job.status))
  .map(({ id, status, exitCode, cleanup }) => ({ id, status, exitCode, cleanup }));
```

Do not repeatedly call status tools to poll. Use the blocking waits or completion
wake-ups; putting a polling loop in codemode does not improve lifecycle correctness.
Load optional tool bundles before use where needed. Model-only tools such as
`ask_user` and `ask_parent` remain excluded from scripts.

## Implementation and limits

`extensions/_shared/structured-result.ts` adds a versioned envelope and recursively
projects explicitly declared fields rather than exposing arbitrary internal
`details`. Projection is not a general secret scanner or a runtime validator.
Tool authors must define intentional schemas and validate shapes in tests. The
SDK does not itself enforce output-schema conformance. Any result-transforming
hook must preserve `structuredContent` when replacing `content`, or Pi can fall
back to text. Progress updates retain their existing display contracts.

Official MCP uses a **different** envelope: scripts receive the server's
`CallToolResult`, with `content`, optional `structuredContent`, and `isError`.
Do not apply the pi-shared version/status/data convention to MCP calls.
See [official MCP](native-mcp.md).

`npm run test:structured-results` checks output contracts and real SDK codemode
behavior using synthetic model streams and local fixtures, without provider
inference. Use `PI_TEST_SDK_DIR` to select the installed Pi 0.99+ SDK rather than
an older global npm SDK. Targeted doctor/coordinator tests cover their additional
structured projections.
