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

The existing `pi openai` shortcut selects the **ChatGPT/Codex subscription** preset,
not OpenAI API-key billing. `pi models` lists configured shortcuts, not every
native Pi model. General native-provider aliases are not added by this change.
`PI_SHARED_DIRECT_LAUNCHERS=0` omits the subscription shortcut; native Pi remains
usable. An existing shortcut opt-out is preserved on reruns.

## Isolation contract

- The launcher records `--direct-only` generation policy. It reads no gateway
  alias catalog, probes no gateway, and creates no gateway profile or generated
  `models.json`. Existing native model/auth configuration stays Pi-owned.
  The packaged launcher uses the native profile saved by setup, including a custom
  `PI_SHARED_AGENT_DIR`; an explicit `PI_CODING_AGENT_DIR` still takes precedence.
- `pi models`, launcher checks, and launcher refresh run offline. Direct launches
  do not depend on a gateway service. They still require valid native provider
  credentials and network access when applicable.
- Gateway catalog or profile overrides cannot be mixed into a direct-only
  launcher. Adding gateway routes later requires explicit reconciliation rather
  than silently changing connection or billing behavior.
- Existing gateway/legacy launcher configurations are refused, not overwritten.
  Setup does not stop or uninstall any already-running service. Do not remove a
  receipt to force a migration; reconcile the old installation first.
- Updates retain the direct-only selection and native settings. Status validates
  configuration; it is not a provider authentication or inference test.

Existing Cloud/Local/Both gateway modes and Existing gateway connections retain
previous behavior. Databricks routing, OAuth management, workspace pools and
remote services are unchanged.
