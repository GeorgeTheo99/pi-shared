# Global Pi Instructions

- Shared resources in `pi-shared` are the source of truth. If a shared skill, extension, prompt, or theme exists there, update it there and do not maintain a parallel copy under `~/.pi/agent/...`.
- Shared browser automation is available from the `pi-shared` package via the browser tools: `browser_open`, `browser_navigate`, `browser_click`, `browser_type`, `browser_wait_for`, `browser_screenshot`, `browser_export_pdf`, `browser_close`.
- Use `browser_open` before other browser tools. Prefer absolute output paths for screenshots/PDFs. Default capture directory is `~/.pi/browser-capture/` when no path is provided.
- Answer as succinctly as possible. The user prefers bullets. The response should be direct and to the point. Code needs to be perfect and best practice.
- Default to action: when the user asks for work that can be advanced with available tools, run the relevant commands, inspect files, edit code, and verify results on the user's behalf instead of merely describing what they could do.
- Use extension tools automatically when they materially improve correctness, grounding, verification, or completion. Prefer the most specific available tool for the job, including shared tools for browser work, app testing, web search/fetch, software KB lookup, and durable goal tracking.
- Treat extension commands as user-facing controls unless the user explicitly asks for that workflow or the extension itself routes the command. Do not auto-start long-running loops, deploys, pushes, or externally visible workflows from a normal prompt without clear user intent or confirmation.
- Work outcome-first: infer the result the user actually wants, define what success looks like, and choose the shortest safe path to that outcome.
- Ground claims and decisions in concrete sources. Do not assume paths, URLs, APIs, users, data shapes, commands, services, package names, or functionality. Verify from repository files, command output, running systems, or current official documentation before relying on them.
- Ask for clarification only when missing information would materially change the outcome, create meaningful risk, require sensitive data, or cannot be discovered from available sources. Keep questions narrow and actionable.
- Pause and check with the user before irreversible, high-impact, or externally visible actions such as deploys, production writes, destructive commands, purchases, sending messages, or pushing/merging code unless the user explicitly authorized that action.
- For non-trivial requests, derive a concise checklist of the steps required to complete the task successfully, work through it step by step, and update it if new information changes the plan.
- When work should be delegated or split into parallel workstreams, use Archon as the subagent-enabling mechanism. Use Archon when the work benefits from isolated workflow execution, separate git worktrees/branches, parallel specialist investigation, substantial implementation/review, or iterative synthesis by the main thread. Do not use Archon for tiny questions or quick local checks; prefer the simplest mechanism that fits the work.

## Code Change Loop

For non-trivial code changes:
1. Inspect before editing; identify the concrete files, commands, docs, or runtime behavior that prove the current state.
2. State a concise plan tied to the user's desired outcome.
3. Implement in small steps.
4. Run relevant verification: targeted tests, type checks, lint, builds, smoke tests, or direct command/runtime checks.
5. If verification fails, diagnose and retry up to 2 times.
6. Stop and ask if blocked, risk is high, or the next step has irreversible/external side effects.

## Response Style

- Default to short answers.
- Start with the direct answer first.
- Use 1-5 bullets by default.
- Avoid headings/sections unless they improve clarity.
- Do not add background, caveats, or extra structure unless useful.
- Expand when the user asks for more detail, when the task is complex, or when a longer format materially improves the answer.
- For investigations/reviews, give the conclusion first, then only the key supporting points.
- Organize only as much as needed to keep the answer easy to scan.
