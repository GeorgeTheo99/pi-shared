# work-plan

Adds an LLM-callable `work_plan` tool for Claude-Code-style execution checklists in Pi.

Use it for non-trivial implementation, refactor, debugging, or UI work. The plan appears as a persistent widget above the editor with one active item, completed items, and dependency blockers.

## Tool

`work_plan`

Actions:

- `set` — replace the current plan with `items`.
- `add` — add one item with `title`.
- `update` — edit an item by `id`.
- `activate` — mark one item active.
- `complete` — mark one item done and advance to the next unblocked todo.
- `block` — mark an item blocked, optionally with `blockedBy` task ids.
- `unblock` — clear blockers and return item to todo.
- `list` — return current plan.
- `clear` — clear the plan.

## Auto-condense

Long-running plans accumulate done items quickly. To keep the widget and the
tool-result text small (and out of the LLM's prompt budget), the renderer
automatically condenses older done items into a single summary line once more
than `KEEP_RECENT_DONE` (default `3`) done items exist. The full state — every
item, its history, timestamps, and notes — is preserved on disk and in the
expanded result view; only the rendering is collapsed. Expanding a tool-result
card in the TUI still shows the complete list.

## Example

```json
{
  "action": "set",
  "items": [
    { "title": "Port backend endpoints", "status": "done" },
    { "title": "Redesign MusicPage layout", "status": "active" },
    { "title": "Add album art color extraction", "blockedBy": [2] },
    { "title": "Browser iteration and final polish", "blockedBy": [2, 3] }
  ]
}
```

The widget renders like:

```text
✳ Redesign MusicPage layout… (2m 13s)
  ✔ Port backend endpoints
  ◼ Redesign MusicPage layout
  ◻ Add album art color extraction › blocked by #2
  ◻ Browser iteration and final polish › blocked by #2, #3
```

Once more than three items are done, the older ones collapse:

```text
✳ Polish hero animation… (45s)
  ✔ 7 earlier tasks done
  ✔ Wire telemetry hook
  ✔ Refactor preview pane
  ✔ Add keyboard shortcut
  ◼ Polish hero animation
  ◻ Final QA pass › blocked by #11
```
