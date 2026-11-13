# ask-user

Adds an LLM-callable `ask_user` tool for structured user questions in Pi.

Use it when the assistant needs a user decision, or a step only the user can perform, before it can proceed. The tool shows an interactive selector with explicit options and returns the selected answer to the model. It can optionally allow a typed custom answer.

The dialog is the only part of the turn the user is sure to see: model reasoning and tool output are hidden, and most tool calls arrive without accompanying text. A call therefore has to stand alone. When it asks the user to run, do, or approve something, the exact commands or steps go in `details`, which is shown under the question and stays in the transcript after the dialog closes.

## Tool

`ask_user`

Parameters:

- `question` — question shown to the user.
- `details` — optional text shown verbatim under the question: the exact commands or steps the user must perform, or the exact command or change being approved.
- `options` — optional list of selectable answers, capped at 12 unique non-empty choices.
- `allow_custom` — allow a typed custom answer. Defaults to `false` when options are supplied and `true` when no options are supplied.
- `custom_prompt` — prompt shown under the question and details when collecting a custom answer.
- `timeout_ms` — optional timeout; timeout is treated as cancellation.

On Pi 0.99+ the tool uses `model-only` exposure: it is declared to the model but never callable from codemode scripts or other tools.

## Example

```json
{
  "question": "How should I proceed?",
  "options": ["Implement it now", "Show me the plan first", "Stop"],
  "allow_custom": true
}
```

A step the user has to perform:

```json
{
  "question": "Installing the sshd config needs your password. Did the check pass?",
  "details": "Run in Terminal on this Mac:\nsudo install -m 644 /tmp/050-hardening.conf /etc/ssh/sshd_config.d/ && sudo sshd -t && echo OK\nExpected: it asks for your password once, then prints OK.",
  "options": ["Printed OK", "Hit an error"],
  "allow_custom": true,
  "custom_prompt": "Paste the error"
}
```
