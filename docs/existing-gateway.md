# Connect Pi to an existing gateway

This is **direct remote access**:

```text
Pi on this Mac → Tailscale/private network or HTTPS → server model-gateway → models
```

No gateway or oMLX service is installed on the client Mac. There is no peer
registration or change to the server. Gateway-to-gateway federation is a separate
[manual configuration](https://github.com/GeorgeTheo99/model-gateway/blob/main/docs/federation.md).

> Requires Homebrew package 0.1.7 or newer and the updated pi-shared module.
> Existing managed installations should run `pi-shared update` first.
> `pi-shared setup --help` lists supported modes. Develop/test in isolated source
> checkouts and disposable profiles, never by editing installed Homebrew files.

## Prerequisites

- A running server model-gateway with authenticated `/v1/models/canonical` and
  `/v1/responses`. Older gateways without canonical discovery need upgrading by
  their operator; there is no fallback to admin endpoints or guessed limits.
- Network access already configured. For Tailscale, both machines must be joined
  and ACLs must allow the server port. Setup does not install Tailscale, join a
  tailnet, open a firewall, or change the server's bind address.
- A **client credential** provisioned by the server operator. Do not use a
  provider API key, admin key, or federation peer key. Identity-aware consumer
  credentials must allow direct model access; consumer-profile selectors are
  outside this flow.
- Store that token in a private, non-symlinked file owned by your user, with
  permissions exactly `0600` and one token only. Its path must be absolute and
  cannot contain symlinked directories. Do not place the token in shell arguments,
  a URL, a repository, or a setup receipt. Setup does not create the server key.

Prefer HTTPS with a valid certificate, for example a separately configured
Tailscale HTTPS endpoint. For trusted private HTTP, opt in explicitly and use a
**numeric** private/Tailscale IP; HTTP hostnames and public IPs are rejected. The
opt-in means you trust that transport—Pi does not establish a VPN for you.

## Setup

Pass the endpoint directly; setup adds remote access while preserving native
providers. In a terminal, it asks for any missing endpoint/credential-file path,
then confirmation—not unrelated component choices:

```bash
pi-shared setup --gateway-url https://server.example-tailnet.ts.net
# Or start with the endpoint prompt:
pi-shared setup --with existing-gateway
```

These focused prompts require setup 0.1.18+ and an updated shared
module. With older packages, supply `--with existing-gateway`, `--gateway-url`,
and `--gateway-key-file` explicitly. `--yes`, `--plan`, and noninteractive use
require all missing connection inputs as flags; no credential value is accepted
in arguments. Existing browser/search selections are preserved, and fresh
component defaults remain visible in the approval plan.

For a gateway listening directly on a Tailscale IP (replace this example IP):

```bash
pi-shared setup --gateway-url http://100.100.1.2:9111 \
  --gateway-key-file "$HOME/.config/pi-shared/gateway.key" \
  --allow-private-http
```

An optional trailing `/v1` is normalized. Reverse-proxy prefixes such as
`https://server.example-tailnet.ts.net/model-gateway` are preserved for both
discovery and inference. Prefix segments may contain ASCII letters, digits,
`-`, `_`, `.`, and `~`; traversal segments, empty segments, encoded paths,
embedded credentials, query strings, and fragments are rejected. Add `--plan` for a
read-only preview, `--without-browser` to omit browser-worker/Chromium, or `--yes`
for noninteractive approval of explicit choices.

Setup performs one bounded authenticated catalog read after approval, without
following redirects or using environment proxies. It neither invokes a model nor
changes server configuration. Errors leave setup incomplete; failed discovery or
invalid metadata does not replace existing client artifacts.

## Models and credentials

```bash
pi models
pi <listed-gateway-alias>
pi <listed-gateway-alias> --default
pi
```

Available canonical models become stable aliases of the form
`gw-<sanitized-model-id>-<digest>`. Exact server model IDs are preserved for
requests. Unavailable models are omitted; an empty catalog never erases working
routes. Explicit context/output limits, thinking levels, and native vision
capabilities are required. Unknown metadata is not guessed. The client uses
Responses API; the gateway owns provider-specific translation. Consumer profiles
and imported federation catalogs are not advertised by this canonical discovery
contract.

Generated files contain only a **credential-file command reference**, never the
token. Pi reads the private file at request time via `pi-gateway`; its permissions
and ownership are checked again. Keep that file in place. Rotating its contents
does not require regenerating model files (coordinate server rotation separately).

## Refresh, updates, and checks

**Automatic refresh.** Each `pi` launch that uses the managed launcher starts a
detached `pi-gateway auto-sync` when the last catalog read for that launcher is at
least 15 minutes old. It reads `GET /v1/models/canonical` once with the saved
endpoint and key-file reference, rewrites the generated catalog files only when the
catalog changed, and never blocks or fails the launch. New gateway models therefore
appear from the next launch. Auto-sync only adds and updates models: a model the
gateway stops listing keeps its route until an explicit `pi-gateway sync` or
`pi-shared update`, so a brief availability blip cannot remove it. The outcome
(`refreshed`, `current`, `auth-rejected`, `unreachable`, `skipped-update-running`
or `error`, with added and no-longer-listed IDs) is recorded in
`<launcher-stem>.gateway-sync.json` beside the launcher. It never writes while
`pi-shared setup`/`update` holds the update lock (it retries at the next launch),
and an unreachable or rejecting gateway leaves the saved catalog in place. Set `PI_GATEWAY_AUTO_SYNC=0` to disable
it; `pi --launcher-refresh`, `pi models` and utility commands stay offline.

`pi-shared update` updates this Mac's installed components, preserves the remote
connection and applies the current remote catalog with `pi-gateway sync`; it does
not update or restart the server. `pi-shared status` checks local artifacts and
credential-file safety offline, then runs `pi-gateway probe`: one authenticated
catalog read with no writes and no inference. Both report one of:

| Exit | Meaning | Fix |
|---|---|---|
| `0` | Key accepted; local catalog matches (or was refreshed by `sync`, removals included) | — |
| `3` | `probe` only: gateway models were added/removed | `pi-gateway sync`, or launch `pi` |
| `4` | Gateway rejected the key (HTTP 401/403), e.g. rotated or retired | Write a new consumer key into the key file, then `pi-gateway sync` |
| `5` | Gateway unreachable (TLS, Tailscale, endpoint) | Check connectivity |

Status exits nonzero on `4`; update only warns.

To refresh now, use the installed client helper with the saved connection:

```bash
pi-gateway sync \
  --url https://server.example-tailnet.ts.net \
  --key-file "$HOME/.config/pi-shared/gateway.key" \
  --cli-out "$HOME/.pi/launcher.json"
```

`sync` refuses an endpoint or key file different from the saved connection; to
change either, rerun the existing-gateway setup or use `connect` with the same
options. Use the same `--allow-private-http` opt-in for private HTTP. Replace
`sync` with `check` for an offline check against that exact endpoint/key-file
reference, or with `probe` for the read-only authenticated check above.
If you customized launcher output, use that path instead.

The helper requires a managed JSON launcher prepared by setup. It preserves
existing direct-launcher choices, route profile, and saved default profile;
manual model-file edits or unrelated unmanaged catalogs cause a refusal rather
than being silently overwritten. The remote alias catalog is saved beside the
launcher as `<launcher-stem>.gateway-aliases.json`.

Writes are atomic **per file**, not a transaction across all three generated
files. An I/O failure during writing can leave partial state: inspect it before
retrying rather than force-overwriting manual changes. Catalog discovery success
is not an inference test; start a listed model and verify a real response.
