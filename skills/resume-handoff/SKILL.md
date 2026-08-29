---
name: resume-handoff
description: Resume from the most recent Pi handoff file. Use when the user wants to resume, continue, or pick up from a previous session's handoff note.
---

# Resume from Handoff

Pick up a task from a previous Pi session's handoff file. Handoffs live in `~/.pi/handoffs/`.

## Step 1: Find the Handoff File

If the user provided a specific file path, use that.

Otherwise, find the most recent handoff file:

```bash
ls -t ~/.pi/handoffs/handoff-*.md 2>/dev/null | head -1
```

If no handoff files exist, tell the user there are no handoff files and stop.

## Step 2: Read and Act

Read the handoff file, then:

1. Briefly summarize what you understand from the handoff (2–3 sentences max).
2. List the next steps from the "What To Do Next" section.
3. Reconcile with current repo state — check `git status --short` and verify key files mentioned still match reality.
4. Ask the user if they want to proceed or adjust anything before you start.
