# pi-shared

A shared [Pi](https://pi.dev) coding-agent environment: model shortcuts, agent
workflows, development tools, and optional browser/search integrations.
**This README describes shipped capabilities, their prerequisites, and their limits.**
A bundled wrapper is not an installed service; configured credentials are not proof
that a provider works. Skills guide the agent—they are not standalone services.

[Install](#install-on-macos) · [Models](#models-and-connections) ·
[Search and MCP](#search-and-mcp) · [Browser](#browser-and-app-testing) ·
[Agent workflows](#agent-workflows) · [Development tools](#development-tools) ·
[Knowledge and artifacts](#knowledge-and-artifacts) · [Maintenance](#maintenance)

## Install on macOS

Review the [Homebrew formula and trust guidance](https://github.com/GeorgeTheo99/homebrew-tap)
first. Formula trust persists for future revisions; on older Homebrew versions
without `brew trust`, omit that command.

```bash
brew trust --formula georgetheo99/tap/pi-shared
brew install georgetheo99/tap/pi-shared
pi-shared setup --plan     # Read-only preview
pi-shared setup            # Review and approve provisioning
pi
```

Homebrew installs the CLI and a pinned stock Pi runtime. Setup installs selected
shared resources/services; it never downloads LLM weights or tests inference.
Fresh defaults are direct providers and browser-worker/Chromium, with search
skipped. Add `--without-browser` to omit browser installation.

The setup examples below target **Homebrew package 0.1.20 and updated shared
modules**. On older installations, run `pi-shared update` and check
`pi-shared setup --help`. Resolve any other installation owning `pi` deliberately;
do not blindly use `brew link --overwrite`.

### Guided setup and saved choices

`pi-shared setup --guided` offers keyboard menus followed by plan approval.
Normal setup uses explicit flags, then saved choices, then defaults; scripts use
`--yes` to approve. `--plan` never opens menus or applies changes. Setup is not a
service-removal or arbitrary MCP-configuration wizard.
[Full setup guide](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/homebrew.md).

## Models and connections

### Native providers and subscriptions

`pi-shared setup --with direct` uses Pi's own provider authentication and model
selection, without requiring a gateway or oMLX. Use `/login` and `/model` inside Pi.
The optional `pi openai` preset selects the ChatGPT/Codex subscription provider,
not OpenAI API-key billing; login remains required.
[Direct-provider contract](docs/direct-providers.md).

### Local gateway and local models

`--with model-gateway` adds a local gateway; provider onboarding and routes are
configured separately. `--with omlx` also selects that gateway, with explicit
`--omlx existing`, `install`, or `guide` handling. A fresh oMLX install requires
Apple Silicon/macOS 15+; selecting it does not download model weights.
[Component prerequisites](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/homebrew.md).

### Existing remote gateway

`pi-shared setup --gateway-url https://server.example/model-gateway` connects to
an already-running compatible gateway without installing one locally. Setup needs
a private client-key file and performs catalog discovery, not inference. Network
access, TLS/Tailscale, server credentials, and server maintenance remain separate.
[Remote-gateway contract and catalog refresh](docs/existing-gateway.md).

### Combining model access

Repeat `--with` to add compatible access while keeping saved choices: direct
providers can coexist with either gateway type, but local and external gateways
cannot coexist in this setup. Legacy `--mode direct|cloud|local|both|later|existing-gateway`
shortcuts remain available; `both` means cloud plus local gateway use, not
native plus gateway. Changing a mode is not an uninstall/migration command.

### Model shortcuts and defaults

```bash
pi models                 # Configured aliases, grouped offline
pi models --cloud         # Gateway aliases classified as cloud-hosted
pi models --verbose       # Full route IDs and profiles
pi models --json          # Machine-readable alias listing
pi <model-alias>           # Launch a listed route
pi <model-alias> --default # Save a default and exit
pi                        # Start with your saved choice
```

`pi models` lists configured shortcuts, **not every native Pi model**, and does
not check authentication or availability. Local hosting can be on another machine;
unknown gateway hosting is labeled unknown. `pi list` still lists packages;
`pi -- <text>` bypasses shortcut interpretation. Native presets can be explicitly
disabled. [Launcher reference](docs/reference.md).

## Search and MCP

### Built-in web search and page retrieval

`web_search` finds results; `web_fetch` retrieves bounded page text. They call a
search broker directly, not the generic MCP adapter. Setup can install local
Brave-backed search (`--search local`, with a private Brave API-key file), connect
an existing endpoint, or skip provisioning. Skipping does not stop existing services.
[Search configuration and credentials](extensions/websearch/README.md).

### Bring your own search backend

```bash
pi-shared setup --search existing \
  --search-url https://search.example/mcp --plan
```

An arbitrary search MCP is **not** a drop-in replacement: the endpoint must expose
`web_search(query, num_results)` and `web_fetch(url, max_chars)` with compatible
HTTP JSON-RPC responses. The native client expects JSON responses, not a general
stdio/session/SSE transport. `deep_research` also requires a JSON search payload
with a `results` array containing usable URLs; title/snippet fields improve evidence.
Different contracts need a compatibility bridge. For bearer authentication, add
`--search-key-file` pointing to a private `0600` file; use HTTPS or loopback HTTP.
[Exact client contract](extensions/websearch/README.md).

### General MCP servers

The optional [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) adds
MCP servers independently of built-in search. Install with
`pi install npm:pi-mcp-adapter`, restart Pi, then use `/mcp setup` for guided
onboarding or configure `.mcp.json` per project / `~/.config/mcp/mcp.json` globally.
It supports stdio/HTTP servers and supported bearer/OAuth flows; server dependencies
and credentials are still required. **The pi-shared setup wizard does not install
or configure this adapter.**

### MCP discovery versus search routing

`/mcp` lists adapter-managed servers; `/mcp-connections` shows adapter metadata
alongside native browser/search integrations without connecting. Adding a search
server to the adapter makes its tools callable through that adapter—it does **not**
replace `web_search`, `web_fetch`, or `deep_research`. Do not duplicate native
broker registrations just to make them appear in `/mcp`.
[Connection boundaries](docs/reference.md#mcp-discovery).

### Multi-source research

`deep_research` and `/research` collect ranked search results, fetched passages,
and diagnostics for the agent to synthesize. They require the same compatible
search broker and use bounded source/fetch budgets, with at most one gap-driven
follow-up round. Evidence is saved locally; completion does not mean exhaustive
coverage or independently verified conclusions.
[Research modes and limits](extensions/deep-research/README.md).

## Browser and app testing

### Public web browsing

`browser_fetch` renders one public page; `browser_inspect` operates short-lived
public browser sessions. They require the separate browser-worker service,
credentials, and browser runtime, provisionable through `--with-browser`.
The worker enforces public-network access: these tools are not for localhost,
private apps, or bypassing site access controls.
[Public-browser setup](extensions/pi-browser-capture/README.md).

### Persistent private-app testing

The `app_open`, `app_click`, `app_type_text`, screenshot, console/network, and
`app_api_request` tools target configured local/private apps. They use an
in-process browser with persistent app state, separate from browser-worker;
configure the app base URL/allowed hosts and install browser dependencies.
These tools are **not isolated fresh tests**.
[App-testing configuration](extensions/pi-browser-capture/README.md).

### Isolated app tests

`app_test` creates fresh desktop/mobile contexts for explicit steps, assertions,
accessibility snapshots, and opt-in traces. It stops at the first failure and
keeps its contexts separate from persistent `app_*` authentication. Requires the
local browser runtime. Evidence is deleted on normal close, expiry, or session
cleanup; crashes can leave private artifacts.
[Isolation and artifact limits](extensions/pi-browser-capture/README.md).

### Native Apple app diagnostics

`/apple-detect`, `/apple-simulators`, `/apple-build`, `/apple-run`, `/apple-test`,
`/apple-screenshot`, and `/apple-logs` support local Xcode app workflows.
They require macOS/full Xcode and appropriate targets/simulators; macOS capture
may require OS permission. These are commands, not model-callable UI-tapping tools
or a TestFlight uploader. [Apple app commands](extensions/apple-app-test/README.md).

## Agent workflows

### Structured questions

`ask_user` offers choices or custom input in interactive UI sessions. Dismissing
or timing out a question aborts the agent loop rather than guessing an answer.
It is not a headless approval mechanism.
[Question tool](extensions/ask-user/README.md).

### Visible work plans

`work_plan` and `/plan` maintain a session-persisted checklist with active, done,
and blocked tasks and dependency links. They display declared progress; they do
not execute tasks or verify that an agent's completion claim is true.
[Work-plan behavior](extensions/work-plan/README.md).

### Long-running goals

`/goal` or `start_goal` persists an objective and queues continuation turns until
completion, interruption, a blocker, or the turn budget. `update_goal` records
progress; pause/resume controls remain available. This needs a running Pi session
and usable model access—not a reboot-resilient background daemon.
[Goal implementation and commands](extensions/goal/index.ts).

### Subagents and worktree isolation

The `subagent_*` tools run separate Pi contexts, singly, in parallel, in chains,
or with bounded clarification exchanges. Child models need working credentials;
project agents/alternate profiles have trust gates. Worktree mode starts from
committed Git state, retains its checkout, and never auto-merges. Context/process
isolation is not a security sandbox.
[Delegation contract](extensions/spawn-subagent/README.md).

### Bundled specialist roles

Six [agent definitions](extensions/spawn-subagent/agents/) ship with delegation:
`scout`, `planner`, `worker`, `reviewer`, `panelist`, and `skill-runner`.
They provide different task instructions, not independent permissions, guaranteed
expertise, or a bundled catalog of organization-specific data integrations.

### Alternate-model opinions

`/panel` requests an alternate-model opinion or comparison. `panel_models` and
`panel_select` discover/select candidates; the [panel skill](skills/panel/SKILL.md)
uses subagents to obtain opinions. It needs usable alternate-model authentication;
vision-required selection excludes text-only models. Selection alone does not
call or health-check a provider. [Panel tools](extensions/panel/README.md).

### Scripted workflows

`workflow` runs trusted JavaScript orchestration; `/workflows` lists saved scripts.
Replay journals are opt-in, inline scripts require approval, and execution is not
sandboxed. [Workflow contract](extensions/workflow/README.md).

- [research-fanout](workflows/research-fanout.js): parallel scouts, then planner synthesis.
- [supervisor](workflows/supervisor.js): a bounded worker/reviewer revision loop.
- [implement](workflows/implement.js): optional reconnaissance, planning, implementation,
  and review. Its worker defaults to a Codex subscription model; provide that
  authentication or override `workerModel`. Reaching the round limit is not acceptance.

### Peer-session coordination

`peer_sessions`, `peer_send`, and receipt tools coordinate live sessions on the
same machine. Notifications stay silent; explicit response requests and correlated
replies can schedule an idle turn in compatible persistent sessions. They do not
interrupt busy work, restart closed sessions, guarantee answers, or lock shared files.
[Messaging and wake semantics](extensions/session-coordinator/README.md).

### Project memory

`memory_read`, `memory_write`, and `/memory` maintain machine-local facts for the
current project, including review/archive operations. Memories enter context as
untrusted references; there is no global or cross-machine memory service.
Do not store secrets. [Memory storage and scope](extensions/memory/README.md).

### Fresh-session handoff

`/self-handoff` creates a reviewable checkpoint, switches to a fresh session in the
same process, transfers the active goal, and copies the plan. It requires TUI and
a persisted session; the child summarizes and waits for user input before resuming.
Redaction is best effort; this is a user command, not a model tool.
[Handoff contract](extensions/self-handoff/README.md).

### File-based handoff

The [handoff](skills/handoff/SKILL.md) and
[resume-handoff](skills/resume-handoff/SKILL.md) skills write/read continuation
notes under `~/.pi/handoffs/`. They support a manually started fresh session;
resumption checks current state and asks before proceeding. They do not perform
the live goal-ownership transfer provided by `/self-handoff`.

## Development tools

### Managed local commands

`command_start` launches bounded local jobs; status, logs, and cancel tools expose
separate process, readiness, and cleanup evidence. Jobs require workspace trust
and are tied to their owner, not restartable services; hard crashes can leave
descendants. A ready port is not a successful test, and cancellation is not
confirmed cleanup.
[Command-job contract](extensions/command-jobs/README.md).

### Blocking waits

`wait_for_condition`, `wait_for_jobs`, and `wait_for_ready` block without repeated
model polling. Calls require a timeout; shell predicates must test the actual
outcome. A terminal job may have failed, and aborting a wait does not cancel its
jobs. [Wait semantics](extensions/wait-for/README.md).

### Explicit verification

`verify` runs declared `.pi/verification.json` checks only after project trust and
approval of the exact config digest. It evaluates TAP/JUnit/exit evidence plus
source/report freshness; it does not invent tests or infer success from prose.
Commands retain normal machine permissions, not a test sandbox.
[Verification setup](extensions/verification/README.md).

### TypeScript and JavaScript intelligence

`code_intel` provides definitions, references, hover, and per-file diagnostics.
It requires trusted `.pi/code-intel.json` and installed/configured language-server
executables. Queries inspect on-disk files with bounded freshness checks—not
unsaved editor buffers—and cannot rename or edit code.
[Code-intelligence setup](extensions/code-intel/README.md).

### Exact edit previews

`safe_edit` previews exact replacements in one UTF-8 workspace file, then applies
by preview/hash with stale-input checks. Apply requires project trust; this is
an opt-in companion to normal `edit`, not fuzzy matching, a multi-file transaction,
or protection against every external-editor race.
[Safe-edit contract](extensions/safe-edit/README.md).

### Environment diagnostics

`dev_doctor` and `pi-doctor` inspect configuration statically by default. Optional
probes resolve dependencies, import trusted extensions, or inspect browser tool
inventory. They do not repair the environment; imports/inventory are not proof
that models or browser actions work. [Diagnostic boundaries](extensions/dev-doctor/README.md).

### Tool discovery and bundles

`enterprise_list_bundles` discovers registered capabilities; load/unload tools
select configured groups of active tool schemas. Bundle activation requires the
machine-local configuration and already-registered tools. It does not install
integrations, start services, or grant access.
[Bundle configuration and limits](extensions/integration-bundles/README.md).

### Tool-result summaries and exact recall

Oversized results can be shortened in later model context while originals remain
in session history. `/tool-summary` controls the policy; `tool_result_recall`
retrieves bounded exact slices from the active branch. Model-based summaries can
use extra inference; recall cannot recover content the original tool already
truncated. [Summary, image-aging, and recall policy](extensions/tool-summary/README.md).

## Knowledge and artifacts

### Software-engineering knowledge base

`kb_search`, `kb_read`, and `kb_sources` provide lexical reference search and
physical-PDF-page citations. Only the catalog/editorial cards ship—not book PDFs
or extracted text. An optional private corpus lives at
`~/.pi/knowledge/software-engineering` (or `PI_SOFTWARE_KB_ROOT`); ingestion needs
Python/Poppler, with optional macOS OCR. Indexing does not verify edition or
completeness. [KB storage and ingestion](knowledge/software-engineering/README.md)
· [KB tools](extensions/software-kb/index.ts).

### Frontend design guidance

[frontend-design](skills/frontend-design/SKILL.md) guides distinctive interface
implementation; [impeccable](skills/impeccable/SKILL.md) covers design critique,
accessibility, layout, motion, and polish. They are agent instructions and
references, not a running frontend builder; implementation and visual checks
still need the target app's tools.

### PowerPoint creation and previews

The [powerpoint skill](skills/powerpoint/SKILL.md) guides `.pptx`/`.potx` creation,
inspection, and editing, with layout/text/font helpers and task-specific dependencies.
Separately, `pptx_preview` converts `.pptx` to PNG via LibreOffice and Poppler;
`pptx_preview_cleanup` removes old previews. Install those system tools separately;
preview rendering is not guaranteed identical to Microsoft PowerPoint.
[Preview implementation](extensions/pptx-preview/src/index.ts).

### iOS screenshots and TestFlight

[ios-screenshots](skills/ios-screenshots/SKILL.md) captures per-screen simulator
images using app launch-argument routing; it needs full Xcode and suitable app
support. [ios-testflight](skills/ios-testflight/SKILL.md) guides signed builds and
uploads; it additionally needs Apple signing/App Store Connect credentials and
explicit approval for external publication. Neither skill provisions those accounts.

### Custom resources

Shared skills and agent guidance live here; project-specific resources belong in
that repository's `.pi/` directory. `prompts/` and `themes/` are currently empty
extension points, **not bundled prompt/theme collections**. Core Pi supplies its
own functionality independently. [Resource and source-install reference](docs/reference.md).

## Maintenance

### Managed updates

`pi-shared update --plan` previews saved selections; `pi-shared update` applies
them. Bare `pi update` delegates to that updater on supported Homebrew installs;
explicit Pi update options retain their stock routing. The runtime follows the
published package pin, not npm latest. `--modules-only` skips the CLI/runtime
upgrade. Changes can restart selected services and are not rolled back as a unit.
[Update contract](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/updates.md).

### Status and reload

`pi-shared status` checks selected components, including trusted extension imports
and applicable local-service probes. It is not an inference or browser-execution
test; an external gateway's client configuration is checked offline. Run `/reload`
after resource-only changes; restart Pi after runtime/Node changes. Legacy shell
launcher migrations may also require a new shell.

### Uninstall without deleting user data

`pi-shared uninstall --plan` previews detaching managed setup; applying teardown
can stop owned services for all their clients. It retains packages, model weights,
credentials, sessions, and other user data; it does not stop an external gateway.
Unsupported ownership/service cases require separate reconciliation. Homebrew
package removal is a separate operation.
[Teardown boundaries](https://github.com/GeorgeTheo99/pi-setup/blob/main/docs/uninstall.md).

### Vanilla recovery

`pi-vanilla` launches stock Pi without shared packages, extensions, skills,
prompts, themes, or context files to help diagnose customization failures.
It defaults to `openai-codex/gpt-5.5` and needs subscription authentication;
`PI_VANILLA_PROVIDER` and `PI_VANILLA_MODEL` select another available provider/model.
It is not a credential reset or environment repair tool.
[Recovery launcher](bin/pi-vanilla).

## Ownership and documentation contract

| Component | Responsibility |
|---|---|
| **pi-shared** | Shared resources, wrappers, model catalog/launcher integration |
| [pi-setup](https://github.com/GeorgeTheo99/pi-setup) | Setup, selected services, saved configuration, updates and teardown |
| [model-gateway](https://github.com/GeorgeTheo99/model-gateway) | Routing, provider authentication and optional federation |
| [Homebrew tap](https://github.com/GeorgeTheo99/homebrew-tap) | Packaged CLI/runtime releases and pins |
| Optional browser/search services and MCP servers | Their own execution, credentials and access policies |

Develop in source checkouts/worktrees, not Homebrew kegs or installed modules.
Publish approved changes, then install through `pi-shared update`; runtime/setup
releases also need their release/pin process. Do not point production profiles
at development branches. [Advanced operations and troubleshooting](docs/reference.md).

When changing a feature, update its entry here and its detailed documentation in
the same change. Describe shipped behavior, prerequisites, side effects, and
failure boundaries; keep proposals in `docs/plans/`. `npm run test:docs` checks
local links/heading anchors and feature/resource inventory coverage—it does **not**
prove prose correct. Reviewers must check that each feature has a clear title,
useful explanation, implementation evidence, and relevant behavioral tests.
