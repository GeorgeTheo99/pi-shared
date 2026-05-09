# Archon Delegate

Shared pi extension that adds ergonomic Archon delegation commands for coding sessions.

## Commands

```text
/archon [options] <task>
/archon-status [latest|id|branch] [--tail N]
```

## Examples

```text
/archon investigate why the chat reconnect flow drops assistant placeholders
/archon --repo server --workflow archon-architect simplify the API routing layer
/archon-status
/archon-status latest --tail 80
```

## Behavior

- Defaults to `archon-assist`.
- Always uses Archon's `--branch` isolation.
- Generates safe branch names when `--branch` is omitted.
- Starts runs in the background by default.
- Writes logs and run records under `~/.archon/logs/pi-archon/`.
- Does not push, merge, or complete branches by itself.

Run `/reload` or restart pi after changing this extension.
