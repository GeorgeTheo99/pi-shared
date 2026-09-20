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

Choose **Existing gateway** in `pi-shared setup`, or pass explicit choices:

```bash
pi-shared setup --mode existing-gateway \
  --gateway-url https://server.example-tailnet.ts.net \
  --gateway-key-file "$HOME/.config/pi-shared/gateway.key"
```

For a gateway listening directly on a Tailscale IP (replace this example IP):

```bash
pi-shared setup --mode existing-gateway \
  --gateway-url http://100.100.1.2:9111 \
  --gateway-key-file "$HOME/.config/pi-shared/gateway.key" \
  --allow-private-http
```

An optional trailing `/v1` is normalized. URL paths other than `/v1`, embedded
credentials, query strings, and fragments are rejected. Add `--plan` for a
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
Responses API; the gateway owns provider-specific translation. Assisted vision,
consumer profiles, and imported federation catalogs are not advertised by this
canonical discovery contract.

Generated files contain only a **credential-file command reference**, never the
token. Pi reads the private file at request time via `pi-gateway`; its permissions
and ownership are checked again. Keep that file in place. Rotating its contents
does not require regenerating model files (coordinate server rotation separately).

## Refresh, updates, and checks

`pi-shared update` updates this Mac's installed components and preserves the
remote connection. It does not update/restart the server or fetch a new catalog.
`pi-shared status` checks local artifacts and credential-file safety **offline**;
it does not prove server reachability, current authorization, or inference.
Likewise, `pi --launcher-refresh` only regenerates from the saved local catalog.

For an explicit remote catalog refresh, rerun the existing-gateway setup with the
same options, or use the installed client helper:

```bash
pi-gateway connect \
  --url https://server.example-tailnet.ts.net \
  --key-file "$HOME/.config/pi-shared/gateway.key" \
  --cli-out "$HOME/.pi/launcher.json"
```

Use the same `--allow-private-http` opt-in for private HTTP. Replace `connect`
with `check` for an offline check against that exact endpoint/key-file reference.
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
