# ask-user

Adds an LLM-callable `ask_user` tool for structured user questions in Pi.

Use it when the assistant needs a user decision before it can proceed. The tool shows an interactive selector with explicit options and returns the selected answer to the model. It can optionally allow a typed custom answer.

## Tool

`ask_user`

Parameters:

- `question` — question shown to the user.
- `options` — optional list of selectable answers, capped at 12 unique non-empty choices.
- `allow_custom` — allow a typed custom answer. Defaults to `false` when options are supplied and `true` when no options are supplied.
- `custom_prompt` — prompt for the custom-answer input.
- `timeout_ms` — optional timeout; timeout is treated as cancellation.

## Example

```json
{
  "question": "How should I proceed?",
  "options": ["Implement it now", "Show me the plan first", "Stop"],
  "allow_custom": true
}
```
