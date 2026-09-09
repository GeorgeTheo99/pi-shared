# integration-bundles

Conservative active-schema selection and bounded discovery for already registered
Pi tools. This does **not** lazily import extensions, start services, grant
permission, or change the MCP gateway's independent discovery boundary.

## Activation contract

- Reads `$PI_INTEGRATION_LIST`, or otherwise
  `~/.pi/agent/master_integration_list.yaml`. An explicit path is authoritative.
  Missing/unreadable/unparseable lists leave activation management **disabled**;
  the three enterprise routers remain registered and discovery still works.
  Load and unload then fail explicitly; `/bundles` is not registered.
- Captures the initial **active** set, not all registered tools. Only those tools,
  plus tools later observed active, are eligible. Non-bundle tools keep that
  selection. Routers are pinned only when eligible, including configured
  `defaults.router_tools`; excluded routers are never forcibly enabled.
- Hides eligible tools in unloaded bundles. `always_load` bundles are pinned;
  `model_always_load` selects defaults using the most-specific matching model
  glob. Model-only defaults are evictable and cease being defaults on a model
  switch. Explicitly loaded bundles are not discarded merely because defaults
  changed. `/bundles reset` reapplies current defaults without relaxing eligibility.
- Reconciles names on every operation/turn, including late registration, removals,
  and same-count replacements. A newly registered tool is eligible only if the
  SDK actually activated it. Newly eligible registrations in loaded bundles
  participate in the next cap calculation; late pinned bundles are retried.
- Preserves observed external active-set additions as manual pins and removals as
  exclusions. On an observed external selection change, even previously hidden
  tools lose eligibility if absent from that selection. This deliberately fails
  closed rather than assuming the bundle manager still owns their hiding.

### SDK provenance limitation

`getAllTools()` exposes SDK-visible definitions/source metadata, **not activation/exclusion
provenance**; core exclusions may omit definitions entirely. This controller compares snapshots with its last applied/observed
set. It cannot detect a manual exclusion of a tool that was already hidden, an
identical active-set write, or a remove/re-add occurring entirely between
observations. Reload also cannot recover eligibility for tools hidden by an old
controller instance. No unknown inactive tool is inferred to be allowed. To
restore eligibility, explicitly enable it through Pi's external tool selection;
loading a bundle is not an exclusion override. Multiple active-set controllers
are not supported; conservative reconciliation may require explicit reselection.

## Budgets and results

Caps come only from `defaults.model_overrides` (most-specific model-id glob);
there is no hardcoded provider cap. Counts are actual **unique unions**, including
overlapping bundles, base selections, manual pins and router overlaps.

- Successful explicit/repeated loads refresh a monotonic **load-recency** counter.
  This is not actual tool-use recency. Oldest non-pinned loads are evicted first.
- A requested load is preflighted while protecting that request. Missing pattern
  matches, excluded tools or an impossible budget fail without evicting existing
  loads. Success checks the resulting active set; the requested bundle cannot
  immediately evict itself. Wildcards cannot reveal tools a service never registered.
- If pinned/base tools alone exceed the cap, optional bundles are evicted but base
  selections are preserved. Status/discovery/prompt report `budgetError`; the
  controller does **not** claim compliance or remove user-selected base tools.
  Reduce that selection/defaults or choose another model. It does not prevent Pi
  from making an over-budget provider request.
- Unloading removes bundle selection, not exclusive ownership of each tool.
  Overlapping loaded bundles, router tools and manual pins can keep tools active.
  Unloading an `always_load` bundle fails.
- Results describe the active set at completion of that operation. Later loads,
  unloads or other controllers can change it, including later calls in a batch.
  Trigger notes include only triggered bundles still loaded after all triggers.

## Compatible tools and commands

No second controller or neutral replacement router is introduced:

- `enterprise_load_bundle({name})` — load an eligible configured bundle.
- `enterprise_unload_bundle({name})` — unload a non-pinned configured bundle.
- `enterprise_list_bundles({query?, group?, limit?, offset?})` — read-only discovery.
- `/bundles [status | load <name> | unload <name> | reset]`.

Successful schema activation is callable on the next model response in the same
run. It is not evidence that credentials or an underlying service work.

## Bounded discovery

The existing list router returns version-1 structured `details` and matching JSON
text: exact identifiers, bundle availability/load state, tool active/eligible
flags, unique tool counts, total matches, truncation and `nextOffset`.

Search covers registered names/descriptions and configured bundle names plus
pi-shared discovery groups: `development`, `browser`, `delegation`, `planning`,
`recall`. These labels never change activation, and are not loadable unless a
machine-local bundle of that name is configured. Only groups containing actual
registered tools are shown. Service-side/MCP catalogs are not queried.

- All case-insensitive, whitespace-separated **literal** query terms must match;
  no user regex execution. `group` is an exact name filter.
- Query/group: 200 characters each. Default 20 rows, maximum 50; offset 0–10000.
- Rows are capped at 16 KB UTF-8, descriptions at 300 characters, memberships at
  20. `fieldsBounded` signals field bounds; each row's `fieldsTruncated` records
  actual field truncation. Exact identifiers are never shortened;
  a row too large for the bound stops the page (possibly with no next cursor).
- Without arguments, returns a bounded first page of bundles, present capability
  groups and tools. Pagination discovers the remainder; search is never an
  implicit activation or external-service probe.

## Verification

```sh
npm --prefix extensions/integration-bundles test
# Equivalent from repository root:
node --no-warnings --experimental-loader ./tests/fixtures/integration_bundles_test_loader.mjs --test tests/integration_bundles*.test.mts
```

Tests use the real local YAML dependency and real installed SDK/TypeBox via a
suite-scoped resolver (no schema mocks). The loader locates the global
`@earendil-works/pi-coding-agent` installation using `npm root -g`; set
`PI_TEST_SDK_DIR` to another installed SDK directory if needed. A disposable,
in-memory SDK session uses a synthetic model stream and local no-op tool to prove
next-turn callability and core exclusions without paid model calls or live profile
activation. Harness regressions cover overlap budgets, failures, exclusions,
manual changes, load-recency, late registrations, model changes and bounded search.

`npm run test:integration-bundles` runs this suite and is included in root
`npm test`. Test execution does not change a live profile or master YAML.
