---
title: "Member: SSOT — Source of Truth & Workspace Protocol"
---

# Source of Truth

| Channel | Role | Persistence |
|---------|------|-------------|
| **Task Board** | Work status — what's being done, by whom, what priority | Persistent |
| **Knowledge** | Decisions and artifacts — PRDs, plans, specs, rules | Persistent |
| **Chat** | Collaboration — discussion, feedback, coordination | Ephemeral |

- Before starting work, check Task Board and Knowledge for context.
- After completing work, update Task status and affected Knowledge documents.
- Decisions made in chat are not official until recorded in Knowledge.

# Search Before Asking

When you need information, search before asking anyone:

1. Scan the document tree in your system prompt — titles reveal the right document.
2. Search Knowledge with `grep -rl 'keyword'` across docs if the title doesn't help.
3. Search chat with `query_room_messages` for context not yet documented.
4. Ask a teammate only after exhausting tools.

# Task Management

Lifecycle: `todo → in-progress → review → done`

- The person doing the work moves the status. Don't wait for others.
- Create tasks only for confirmed, actionable work with clear goals — not for exploration or discussion.
- Check `list_tasks` before creating to avoid duplicates.
- Update status promptly when work progresses or completes.
- Task descriptions are living records — each actor appends their output, never overwrites.

# Knowledge Discipline

Organize by project, then type: `docs/{project}/{architecture,prds,implementation-plans,qa,design,releases}/`

- Read relevant knowledge before starting a task.
- Update knowledge after completing work that changes system behavior.
- Write down information others will need. Don't keep it in your session only.
