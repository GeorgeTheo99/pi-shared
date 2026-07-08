# integration-bundles

Lazy tool-bundle loader for Pi, driven by
a machine-local `master_integration_list.yaml` (resolved from `$PI_INTEGRATION_LIST` or `~/.pi/agent/master_integration_list.yaml`). The bundle definitions are domain/machine-specific and intentionally not part of pi-shared.

## Why

OpenAI's Responses / Chat Completions API rejects requests with more than
**128 tools**. The `pi-enterprise` extension registers ~90 tools, plus shared
extensions and built-ins, which pushes GPT and o-series models over the limit.
Anthropic / Claude has a much higher cap, so the same setup works there
without trimming.

This extension solves that without losing capability:

1. Reads `master_integration_list.yaml` (single source of truth) where each
   bundle has a name, an LLM-readable `description`, glob patterns for the
   tools it owns, and optional regex `triggers`.
2. Hides every bundle that is not in `defaults.always_load` until something
   loads it. Bundles can be loaded:
   - by the **model** calling `enterprise_load_bundle("<name>")`,
   - by **regex auto-trigger** when the user message clearly mentions the
     domain (e.g. `ES-12345` → `jira`), or
   - by the user via the `/bundles` slash command.
3. Enforces a **per-model tool cap** in `before_agent_start`, pruning the
   active set down to the cap (≤120 for `gpt-*` / `o*`, unlimited for
   `claude-*`). LRU-loaded bundles get evicted first.
4. Injects an `<available_bundles>` block into the system prompt so the model
   can self-discover what's available based on natural-language descriptions.

## Tools

The extension keeps **three router tools always-on**:

- `enterprise_load_bundle(name)` — loads a bundle by name.
- `enterprise_unload_bundle(name)` — frees its slots.
- `enterprise_list_bundles()` — show what's registered, loaded, or available.

## Slash commands

- `/bundles` — show full status (loaded, available, model cap, current
  active-tool count).
- `/bundles load <name>` — manually load a bundle.
- `/bundles unload <name>` — manually unload a bundle.
- `/bundles reset` — reset to `defaults.always_load`.

## Configuration

Edit the machine-local `master_integration_list.yaml` (see resolution order above). The file is the contract.

## Compatibility

Works alongside `pi-enterprise` — it does not replace it. `pi-enterprise`
still registers all of its underlying tools at session start; this extension
just controls which of those tools are visible to the model.
