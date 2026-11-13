# Secret redaction in tool results

A `tool_result` handler that removes credentials from every tool result (bash, read,
codemode, MCP and nested calls) before Pi stores it in the session or sends it to the
model. It answers one failure mode: an agent checking a secret file, an environment
variable or a connection string prints the value, and the value lands in the transcript.

## What is matched

| Layer | Matches | Replacement |
|---|---|---|
| Exact values | Every file in `~/.config/<tool>/secrets/` (for example `cloud-console`, `model-gateway`) and each directory in `PI_SECRET_DIRS` (colon-separated): the whole value, each line, `KEY=VALUE` values, JSON string values, and URL passwords (encoded and decoded). Values under 12 characters are ignored. | `[REDACTED secret:<file>]` |
| Token formats | Private key blocks, Neon (`napi_`), Stripe and Clerk secret keys (`sk_`/`rk_` live and test), webhook secrets (`whsec_`), Anthropic, OpenAI and OpenRouter keys (`sk-`), GitHub, GitLab, npm and Slack tokens, AWS access key IDs, Google API keys, JWTs | `[REDACTED <kind>]` |
| URL passwords | `scheme://user:password@` (not placeholders such as `<random>`, `...`, `$VAR`) | `[REDACTED password]` |

Stores are re-read when a file or directory changes (checked at most every 2 seconds), so a
rotated key is covered without a restart. Text parts of `content`, every string in
`details`, and `structuredContent` are redacted; unchanged results pass through untouched.

## Limits

- **Images are not redacted.** A screenshot of a console showing a key still carries it.
- **Overflow files are not redacted.** When a tool saves its full output to a temporary file,
  that file on disk keeps the original text; only what reaches the session is redacted.
- **Live TUI output** streamed while a command runs is display-only and not rewritten.
- **The model's own messages** are not tool results; never paste a secret into a command.
- **Fixtures that look like tokens** in source files are redacted when read, so an `edit`
  whose `oldText` includes one will not match. Edit around them, or set
  `PI_SECRET_GUARD=off` for that session.

Verification: `npm run test:secret-guard`.
