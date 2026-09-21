# pi-shared

A shared [Pi](https://pi.dev) coding-agent environment: model shortcuts, reusable
skills, tools, project memory, subagents, and browser/research integrations.
**Start here** to install, choose your model connection, and keep it updated.

## Install on macOS

Review the [Homebrew formula and trust guidance](https://github.com/GeorgeTheo99/homebrew-tap)
first. Formula trust persists for future revisions; on older Homebrew versions
without `brew trust`, omit that first command.

```bash
brew trust --formula georgetheo99/tap/pi-shared
brew install georgetheo99/tap/pi-shared
pi-shared setup
pi
```

`brew install` installs the CLI and pinned stock Pi runtime. **Setup is explicit:**
it shows the selected components and asks before provisioning them. No model
weights are downloaded automatically. If another installation owns `pi`, resolve
that conflict deliberately—do not blindly use `brew link --overwrite`.

## Choose your model connection

**Direct providers** requires Homebrew package **0.1.8 or newer** and an updated
shared module. Run `pi-shared update` first on existing installations.
See [direct-provider setup](docs/direct-providers.md).

| Setup choice | Use it for |
|---|---|
| Direct providers | Native Pi subscriptions/API keys; no model-gateway or oMLX |
| Cloud | Gateway-enabled cloud use; installs a local gateway for provider onboarding |
| Local | Models on this Mac through oMLX; installation and downloads remain explicit |
| Both | Cloud and local model use |
| Existing gateway | Connect this Mac directly to a server gateway, including over Tailscale; no local gateway |
| Later | Install shared tools now and configure models later |

**Existing-gateway onboarding requires Homebrew package 0.1.7 or newer and an
updated shared module.** Run `pi-shared update` on an existing managed install;
`pi-shared setup --help` lists the connection options.
See [connecting to a server gateway](docs/existing-gateway.md) for prerequisites,
credentials, TLS/private-network options, and explicit catalog refresh.

Browser-worker is selected by default; `--without-browser` omits it and Chromium.
Search is optional and needs its Brave key provisioned first. Cloud login/provider
credentials and actual model inference remain separate checks.

Preview a setup without changing anything:

```bash
pi-shared setup --mode cloud --plan
```

Full component choices and prerequisites live in the
[setup guide](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/homebrew.md).

## Use Pi

```bash
pi models                 # Grouped local, cloud, and direct aliases (offline)
pi models --cloud         # Only cloud models routed through the gateway
pi models --verbose       # Include full route IDs and profiles
pi models --json          # Structured output for scripts
pi openai                 # ChatGPT subscription preset; use /login to authenticate
pi <model-alias>           # Start with a gateway model
pi <model-alias> --default # Save your default and exit
pi                        # Start with your saved choice
```

`pi list` still lists Pi packages. Model shortcuts require a configured catalog;
subscription login alone does not create gateway routes. Direct presets such as
`openai` are absent if you explicitly disabled them. Use `pi -- openai` to send
that word as a literal prompt rather than select the preset.

Grouped `pi models` requires **Homebrew 0.1.9 or newer** and the updated shared
module; run `pi-shared update` on existing managed installations.
`pi models` uses catalog names and puts alternate aliases on the same row.
`--local`, `--cloud`, and `--direct` select one group; combine a filter with
`--verbose` or `--json`. Local means locally hosted inference, possibly on another
machine. Remote canonical catalogs without hosting metadata appear under
**Gateway · hosting unknown**, not as guessed local/cloud models.

`★` marks the saved default in the selected profile (`PI_CODING_AGENT_DIR`, then
launcher default profile, then `~/.pi/agent`). Project/session overrides can differ.
Listing makes no network or authentication checks; it retains the launcher's
existing offline refresh of generated routes from the saved catalog.
`pi --launcher-list` retains the legacy tab-separated alias/route output.

## Update and check

```bash
pi-shared update --plan
pi-shared update
pi-shared status
```

Updates reuse your saved component selection. An external gateway stays externally
managed: this Mac never installs, upgrades, or restarts it. Status checks local
configuration; it does **not** prove remote authentication, inference, or browser
execution. Remote catalogs refresh only when explicitly requested.

Restart Pi after runtime/Node upgrades, and open a new shell after legacy launcher
migration. `/reload` refreshes resources, not the running runtime. See the
[update contract](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/updates.md).

## What’s included

- **Agent workflows:** [subagents](extensions/spawn-subagent/README.md),
  [goals](extensions/goal/), [handoffs](extensions/self-handoff/README.md),
  [peer coordination](extensions/session-coordinator/README.md), and project memory.
- **Development tools:** bounded command jobs, explicit verification, code
  navigation, safe edits, and [environment diagnostics](extensions/dev-doctor/README.md).
- **Web and app tools:** public-browser and search wrappers, plus isolated
  local/private app testing. Optional services have their own prerequisites.
- **Reusable resources:** [skills](skills/), [prompts](prompts/), [themes](themes/),
  and [workflows](workflows/).

See the [resource reference](docs/reference.md#included-shared-extensions) and
[development-tooling guide](docs/plans/development-tooling-implementation.md)
for detailed capabilities and activation requirements.

## Project boundaries and development

| Repository | Responsibility |
|---|---|
| **pi-shared** (this repository) | Main entry point, shared Pi resources, model catalog/launcher integration |
| [pi-setup](https://github.com/GeorgeTheo99/pi-setup) | Setup wizard, component installation, saved selections, updates |
| [model-gateway](https://github.com/GeorgeTheo99/model-gateway) | Model routing, provider authentication, federation |
| [Homebrew tap](https://github.com/GeorgeTheo99/homebrew-tap) | Package formula and release pins |

Gateway-to-gateway [federation](https://github.com/GeorgeTheo99/model-gateway/blob/main/docs/federation.md)
is a separate advanced setup; direct remote access does not need it.

Develop in a separate source checkout/worktree, not the Homebrew keg or installed
modules under `~/.local/share/pi-shared/modules`. Publish approved changes, then
consume them through `pi-shared update`; installer/runtime changes also require an
approved release and tap pin. Keep shared resources canonical here rather than
maintaining parallel copies under `~/.pi/agent`.

For source-only installs, legacy shell launchers, recovery, private overlays,
and troubleshooting, use the [advanced reference](docs/reference.md).
