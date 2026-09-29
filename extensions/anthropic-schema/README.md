# Anthropic Schema

A `before_provider_request` hook that makes outbound tool definitions acceptable to
Anthropic's API. It changes only requests to the built-in `anthropic` provider and
registers no tools or commands.

## What it rewrites

For each tool in the request payload:

- Removes validation keywords Anthropic rejects: numeric bounds (`minimum`,
  `maximum`, `exclusive*`, `multipleOf`), array bounds (`minItems`, `maxItems`,
  `uniqueItems`), string constraints (`minLength`, `maxLength`, `pattern`,
  `format`), and object property counts.
- For tools Pi sent with `strict: true`, drops `strict` and unwraps the optional
  `anyOf: [T, {type: "null"}]` wrappers Pi generates for optional fields, restoring
  them as optional. This keeps large tool sets under Anthropic's strict-schema
  union limit.

The rewrite uses the schema already in the payload rather than the current tool
registry, so resumed transcripts keep their original tool definitions.

## Limits

- Pi still validates tool arguments locally against the original schema, so
  removed constraints are enforced after the model responds, not during sampling.
- A genuinely required nullable field looks identical to Pi's optional wrapper and
  is loosened on the wire; local validation still rejects a missing value.
