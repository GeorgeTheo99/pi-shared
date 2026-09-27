# Direct providers without model-gateway

> Requires Homebrew package **0.1.8 or newer** and the updated shared module.
> Run `pi-shared update` first on existing installations; confirm that
> `pi-shared setup --help` lists `direct`. Do not replace installed runtime files
> or point production profiles at development worktrees.

The new explicit setup choice is:

```sh
pi-shared setup --mode direct --plan
pi-shared setup --mode direct
# Shared resources only, without browser-worker/Chromium:
pi-shared setup --mode direct --without-browser
```

Direct mode installs shared resources and any separately selected browser/search
components, **not model-gateway or oMLX**. Pi owns provider authentication and model
selection. Use `/login` and `/model` inside Pi, or its native `--provider` and
`--model` options. Provider/API credentials are not collected by this setup.
pi-shared fills missing native `openai-codex` context overrides with Codex's
published 872K opt-in ceiling for GPT-5.6 Luna/Sol/Terra and GPT-6 Astra/Luna/Sol.
It preserves existing overrides and all `openai` API settings; unknown models
keep Pi's defaults. This changes compaction planning, not provider entitlements.
To persist a deliberate choice across future sessions, run one of:

```sh
pi openai --set-context=standard  # 272K
pi openai --set-context=max       # 872K
```

This offline command saves and exits without starting Pi. It replaces the
`contextWindow` values for all six reviewed `openai-codex` models in the selected
profile's `models.json`, including any earlier per-model context choices, while
preserving other override fields and direct `openai` API configuration. A later
setup/update fills only missing overrides, so it does not undo a saved choice.
Gateway-generated and symlinked model files are refused. Existing Pi sessions
must restart to read the change; a larger configured window does not itself
consume tokens or guarantee provider entitlement.

The existing `pi openai` shortcut selects the **ChatGPT/Codex subscription** preset,
not OpenAI API-key billing. It uses that profile's `/model`-saved Codex default;
without one, it falls back to GPT-6 Astra. Switching models without saving the
default (Ctrl+S in `/model`) affects only the current session.

`pi anthropic` and the generated zsh `pi-anthropic` helper select Pi's native
Anthropic provider. In Pi run `/login anthropic` and select Claude Pro/Max OAuth;
Pi stores and refreshes its own credential. **This is not the same billing as
Codex:** Pi's provider documentation says third-party Claude Pro/Max usage draws
from [extra usage](https://claude.ai/settings/usage) billed per token, not plan
limits. No login or charge is triggered by setup. Alternatively use `/login
anthropic` to store an API key, or set `ANTHROPIC_API_KEY`; Pi's saved auth
credential takes priority over the environment. The launcher does not create
or switch credentials. `pi anthropic` follows that profile's `/model`-saved
Anthropic default (fallback: `claude-sonnet-4-6`), while `pi-anthropic` uses
that fallback unless overridden with `--model` and scopes its picker to
`anthropic/*`. Direct launchers are opt-in; `PI_SHARED_DIRECT_LAUNCHERS=0` omits
both shortcuts, and an existing opt-out is preserved on reruns. `pi models`
lists configured shortcuts, not every native Pi model.

## Isolation contract

- The launcher records `--direct-only` generation policy. It reads no gateway
  alias catalog, probes no gateway, and creates no gateway profile or generated
  gateway `models.json`. The installer may add only missing Codex context
  overrides to the native profile's `models.json`, preserving user-defined model
  entries and override values. Symlinked or gateway-generated native catalogs
  are never modified; auth remains Pi-owned.
  The packaged launcher uses the native profile saved by setup, including a custom
  `PI_SHARED_AGENT_DIR`; an explicit `PI_CODING_AGENT_DIR` still takes precedence.
- `pi models`, launcher checks, and launcher refresh run offline. Direct launches
  do not depend on a gateway service. They still require valid native provider
  credentials and network access when applicable.
- Direct access and gateway access can coexist. An explicit gateway-enabled
  setup can upgrade a generated direct-only launcher, retaining native provider
  settings, credentials, the default profile, and the subscription-shortcut
  preference. Gateway shortcuts use a separate managed profile; adding them
  does not make gateway routing the default.
- Installer integrations authorize this additive transition with
  `pi-shared-install --enable-gateway` (or `PI_SHARED_ENABLE_GATEWAY=1`) and
  `PI_SHARED_DIRECT_ONLY=0`. Prefer the CLI flag so older installers fail closed
  instead of ignoring an unfamiliar environment variable. Ordinary refreshes
  do not change connection policy. A custom/malformed launcher or an existing
  destination `models.json` is refused before installer writes; select a new
  dedicated gateway profile or explicitly reconcile that configuration first.
  Remote-gateway integrations should bootstrap with an absent alias-catalog
  path, then run `pi-gateway connect`, rather than adopt stale local aliases.
- Existing gateway/legacy launcher configurations are refused, not overwritten.
  Setup does not stop or uninstall any already-running service. Do not remove a
  receipt to force a migration; reconcile the old installation first.
- Updates retain the direct-only selection and native settings. Status validates
  configuration; it is not a provider authentication or inference test.

Existing Cloud/Local/Both gateway modes and Existing gateway connections retain
previous behavior. Databricks routing, OAuth management, workspace pools and
remote services are unchanged.
