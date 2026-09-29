# Goal

Durable, session-scoped goals that keep the agent working across turns until the
objective is complete, blocked, paused, or out of turn budget.

## Commands

```text
/goal <objective> [--max-turns N]   start a goal (default budget: 60 turns)
/goal status                        show the current goal and progress log
/goal pause | resume | clear        control autopilot
/goal reclaim                       recover a goal after an interrupted self-handoff
```

Pressing Escape during an active goal's turn pauses autopilot without consuming the
interrupted turn; `/goal resume` continues.

## Tools

- `start_goal` — lets the agent create a goal from a normal session when the user
  explicitly requests or strongly implies multi-turn/autonomous tracking. Not for
  one-shot tasks.
- `update_goal` — records progress, completion (after an evidence audit), a blocker,
  or a pause.

## Behavior

- State is stored as `pi-goal-state` custom entries in the session file, so a goal
  follows the session branch and survives `/reload` and resume.
- After each finished agent run, an active goal queues a hidden continuation turn
  until a terminal status or the turn budget is reached.
- During a fresh `/self-handoff` child's orientation turn, goal changes and
  continuation are held until the user sends an explicit message.

## Limits

Goals run only inside a live Pi session with usable model access. This is not a
background daemon: nothing resumes after Pi exits or the machine reboots.
