# Recommended toolchain and provider scoping

pi-shared does not install these tools. This page lists the CLIs that give agents
the most uplift, and where provider-specific MCP servers and skill packs should
live so they load only in the projects that use them.

## Context cost by resource type

| Resource | Cost in every session | How to scope it |
|---|---|---|
| CLI on `PATH` | None | Not needed |
| MCP server with `codemode` exposure | One `mcp_servers` line | Project `.pi/mcp.json` enable override |
| Skill | Name and description | Project `.agents/skills/` |
| Extension tool | Full JSON schema | [integration bundles](../extensions/integration-bundles/README.md) |

Prefer a CLI over an MCP server, and an MCP server over a skill, when each would do
the job equally well. Global skills cost context in every session and every subagent.

## Recommended CLIs

Install only the groups that match your stack.

| Group | Tools | Why agents benefit |
|---|---|---|
| Core | `gh`, `jq`, `ripgrep`, `fd`, `uv`, `ast-grep` | Native queries and structural code search/rewrite instead of regex edits |
| Postgres | `libpq` (`psql`) | Query databases in SQL instead of ad-hoc scripts |
| Data files | `duckdb` | SQL over CSV/Parquet/GeoParquet without loading dataframes |
| CI and supply chain | `actionlint`, `osv-scanner`, `gitleaks`, `shellcheck` | Catch workflow, dependency and secret problems before pushing |
| Vercel | `vercel` | Env pulls, deploy logs, preview deploys |
| Neon | `neonctl` | Throwaway database branches per worktree or test run |
| Stripe | `stripe` | `stripe listen --forward-to` and `stripe trigger` for local webhook tests |
| Cloudflare | `cloudflared`; `wrangler` as a project dev dependency | Tunnels and Workers |
| Apple | Full Xcode, `xcodegen`, `xcbeautify` | Generated projects and compact, agent-readable `xcodebuild` output |
| Rust/Tauri | `rustup` | Required to build Rust and Tauri apps |

```sh
brew install gh jq ripgrep fd uv ast-grep libpq duckdb actionlint osv-scanner gitleaks shellcheck
brew link --force libpq
brew install neonctl stripe/stripe-cli/stripe cloudflared xcodegen xcbeautify rustup
npm i -g vercel
```

Homebrew's `rustup` is keg-only. Add it and cargo-installed tools to your shell
`PATH`, then pick a toolchain:

```sh
echo 'export PATH="/opt/homebrew/opt/rustup/bin:$HOME/.cargo/bin:$PATH"' >> ~/.zshrc
exec zsh && rustup default stable
```

## Provider MCP servers

Define each provider server once in `~/.pi/agent/mcp.json`, disabled, with
`codemode` exposure and a one-line `description`:

```json
{
  "mcpServers": {
    "vercel": { "url": "https://mcp.vercel.com", "exposure": "codemode", "enabled": false,
                "description": "Vercel (OAuth): projects, deployments, build/runtime logs, env vars" },
    "neon":   { "url": "https://mcp.neon.tech/mcp", "exposure": "codemode", "enabled": false,
                "description": "Neon (OAuth): projects, branches, SQL" },
    "stripe": { "url": "https://mcp.stripe.com", "exposure": "codemode", "enabled": false,
                "description": "Stripe (OAuth): customers, products, payments, docs search" },
    "xcode":  { "command": "xcrun", "args": ["mcpbridge"], "exposure": "codemode", "enabled": false,
                "description": "Xcode MCP bridge (needs Xcode running): build, test, diagnostics" }
  }
}
```

Enable a server only in the projects that need it, with a project `.pi/mcp.json`
that overrides just `enabled`:

```json
{ "mcpServers": { "vercel": { "enabled": true }, "neon": { "enabled": true } } }
```

Disabled servers do not connect at startup. Sign in once with `/mcp login <server>`;
tokens stay in the user-level `mcp-auth.json`, never in the project file.

## Skill packs

- **Vendor packs** (for example `vercel-labs/agent-skills`, `neondatabase/agent-skills`,
  `microsoft/azure-skills`): run `npx skills add <owner/repo>` inside the project, so
  they install to its `.agents/skills/` with a lockfile. Avoid global (`-g`) installs
  for provider packs: every session pays for their descriptions. Do not vendor
  third-party packs into pi-shared.
- **Skills you write for one provider**: keep them in a project, or in a pi-shared
  directory outside the default `./skills` path that projects opt into through a
  package filter in `.pi/settings.json`. `./skills` is for skills every machine needs.

Project skills and `.pi/mcp.json` load only after project trust, and only when Pi's
working directory is inside that project. Give subagents a `cwd` inside it too.
