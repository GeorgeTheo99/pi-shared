---
name: handoff
description: Hand off the current task to a new session (pi, Claude Code, or Codex CLI) with full context. Use when the user asks for a handoff, continuation note, or wants to pause and transfer work.
---

# Handoff to New Session

You are handing off the current conversation to a brand new session. Follow these rules exactly.

Detect which tool you are running in by checking environment or context, then tailor the resume instructions accordingly.

## Hard Constraints (Handoff-Only Mode)

When this skill is invoked, you must do handoff work only.

1. Do not continue implementation work.
2. Do not edit project/source files (except the handoff file under `~/.claude/handoffs/`).
3. Do not run commit/push/rebase or any destructive git commands.
4. Do not run build/test/lint for new work.
5. Do not execute follow-up task steps after writing the handoff.

Allowed actions are read-only context gathering plus creating one handoff file.

## Step 1: Write the Handoff File

Create a comprehensive handoff document at `~/.claude/handoffs/handoff-$(date +%Y%m%d-%H%M%S).md` with the following structure:

```markdown
# Handoff Context

## Working Directory
<the current working directory>

## Task Summary
<A clear, concise summary of what the user has been working on in this session. Include the original goal and current state.>

## What Has Been Done
<Bullet list of concrete actions taken: files created, edited, commands run, decisions made. Be specific with file paths and function names.>

## Current State
<Where things stand right now. What's working, what's broken, what's in progress.>

## Key Files
<List the most important files the next session should be aware of, with brief descriptions of their roles.>

## What To Do Next
<Based on the user's handoff notes, describe the next steps clearly. If no notes were provided, describe the logical next step based on current state.>

## Important Context
<Any gotchas, non-obvious decisions, environment details, or constraints the next session needs to know about.>
```

Make the handoff document thorough but concise. The next session has zero prior context — everything it needs must be in this file.

## Step 2: Verify Before Responding

Before your final response, confirm all of the following:

1. The handoff file exists at the path you will report.
2. The file is non-empty.
3. All required sections are present.

## Step 3: Instruct the User

After writing the file, output only the following:

1. The handoff file path
2. A 1-2 line summary of what you wrote
3. Then tell the user how to continue, based on which tool you are running in:

**pi:**
```
To continue in a fresh pi session:
  pi @~/.claude/handoffs/handoff-YYYYMMDD-HHMMSS.md "Continue from this handoff"
```

**Claude Code:**
```
To continue in a fresh Claude session:
  1. Type /new to clear context
  2. Type /resume-handoff to pick up where we left off
```

**Codex CLI:**
```
To continue in a fresh Codex session:
  1. Start a new session with your codex-* launcher (e.g. codex-default)
  2. Ask Codex to "resume from handoff" — it will find the latest file automatically
```

Only output the instructions for the tool you are currently running in. Stop after this output.
