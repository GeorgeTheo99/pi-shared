# Shared model gateway: detect and connect

Status: proposal. Not implemented except where marked **done**.

## Goal

One model gateway per macOS user account. The gateway owns its install,
service, data and updates. Every other product (Pi via pi-setup, Home Server,
My AI) is a client that finds it through the discovery file and uses its own
consumer key. No client installs, updates, or takes over a gateway it did not
install.

## Current behavior

All installers share one identity: launchd label `com.local.model-gateway`,
port `9111`, and `~/Library/Application Support/model-gateway/endpoint.json`.
So two gateways never run at once, but they do not share either:

| Installer | Today |
|---|---|
| model-gateway `install.sh` | Refuses a label owned by another tree unless `--force`, which takes it over |
| pi-setup `setup --with model-gateway` | Runs the module installer, so refuses the same way |
| pi-setup `setup --with existing-gateway` | Connects to a gateway by URL and key file, but only when chosen explicitly |
| Home Server package | Installs its bundled gateway as mandatory; refuses a label it does not own |
| My AI | Client only; reads `endpoint.json` and its `myai-runtime` key (**done**: LaunchAgents no longer pin the URL) |

## Discovery contract

`endpoint.json` (version 1, owner-only, never symlinked) already provides
`base_url`, `health_url`, `port`, `model_aliases`, and `consumers`: an object
mapping credential IDs to `{consumer, key_file, permissions, namespaces,
allow_direct_models}`. It holds paths, never tokens.

A client treats the gateway as present when the file validates and
`health_url` returns `{"status": "ok", "service": "model-gateway"}`.

Proposed addition: `managed_by` (for example `model-gateway`, `pi-setup`,
`home-server`) so installers can report who updates the gateway instead of
guessing from the plist's `WorkingDirectory`.

## Installer changes

### pi-setup

- `setup --with model-gateway` when a healthy gateway is discovered and not
  owned by this installation: default to connecting instead of installing.
  - Catalog: `model_aliases` from the discovery file (current local mode), not a
    remote snapshot.
  - Credential: `consumers["pi-runtime"].key_file`, passed to
    `pi-shared-install --gateway-key-file` (**done**: flag shipped in pi-shared
    `9686031`; the generated `apiKey` is a key-file reference, never the token).
  - No `pi-runtime` consumer registered: print the gateway's consumer
    registration command and stop. Do not fall back to the legacy shared key.
- `pi-shared update` never updates a gateway it did not install; status reports
  the discovered owner.

### Home Server package

- When a healthy gateway owned elsewhere is discovered, skip the bundled
  gateway, record "external gateway" in the install receipt, and use the
  `ha-runtime` consumer key.
- Keep the bundled gateway as the default only when none is discovered.

### My AI

- Already a client. Remaining: fail installation or health with a clear
  "no model gateway discovered" instead of silently defaulting to
  `127.0.0.1:9111`.

## Decision needed

Who updates a shared gateway: its owner only (proposed), or any client with a
deployer credential? The proposal keeps update authority with the owner and
makes clients read-only consumers.

## Security follow-ups

- Every client uses its own consumer key; retire legacy shared client keys once
  no client sends them.
- Consumer keys stay mode-0600 files referenced by path; tokens never appear in
  generated configs, logs, or argv.
