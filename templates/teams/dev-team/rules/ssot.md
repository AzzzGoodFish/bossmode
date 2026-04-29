---
title: "Member: SSOT — Source of Truth & Workspace Protocol"
---

# Source of Truth

The team has three information channels. Know which one to trust:

| Channel | Role | Persistence |
|---------|------|-------------|
| **Task Board** | Work status — what's being done, by whom, what priority | Persistent |
| **Knowledge** | Decisions and artifacts — PRDs, plans, specs, rules | Persistent |
| **Chat** | Collaboration process — discussion, feedback, coordination | Ephemeral |

- Before starting work, check Task Board for current assignments and Knowledge for context.
- After completing work, update the relevant Task status and Knowledge documents.
- Do not treat chat messages as authoritative — decisions made in chat must be recorded in Knowledge to be official.

---

# Task Management

Tasks are the team's shared dashboard — a supplement to chat that tracks what's being worked on, by whom, and where it stands. Chat is the battlefield; the task board is the scoreboard.

## Task Lifecycle

```
todo → in-progress → review → done
```

## Who Creates Tasks

- **The team coordinator (or any member) creates tasks** with clear acceptance criteria when receiving work requests.
- **Any member can create tasks** for items they discover during work — tech debt, bugs, refactoring needs. Important tasks should be confirmed with the coordinator for priority.

## Who Moves Status

The person doing the work moves the status. Do not wait for someone else to update your task.

| Transition | Who | When |
|-----------|-----|------|
| → todo | Creator | Task created with requirements |
| todo → in-progress | Assignee | Starting work on the task |
| in-progress → review | Assignee | Work complete, ready for verification |
| review → done | Verifier | Verification passed, accepted |

## When to Use Task Tools

### create_task
- After decomposing a user request into actionable work items
- When discovering a bug, tech debt, or follow-up item during your work
- When handing off work to another agent and you want a tracked record
- A discussion produces an actionable item that shouldn't be forgotten

### update_task
- Move to in-progress when starting work
- Move to review when your part is complete
- Move to done after verification passes
- Adjust priority or reassign when scope changes

### list_tasks
- Before starting new work, to check current board state
- To find a task ID before updating it
- To compile a status report

### When NOT to create a task
- The work is so small it fits in a single agent turn (just do it)
- A similar task already exists (use list_tasks first to check)
- The request is informational only (use chat to respond instead)

## Task Granularity

- One user request = 1 main task or 2–5 subtasks
- A task should represent a work unit one person can complete in a focused session
- Too coarse ("build mobile adaptation") hides progress; too fine ("fix this CSS margin") creates noise

## References

Tasks can link to reference documents using the `references` parameter — an array of document paths or URLs.

- **When to add references:** When creating a task that involves implementation work, link the relevant PRD, implementation plan, test plan, or design spec. Example: `references: ["docs/bossmode/prds/prd-task-board.md", "docs/bossmode/implementation-plans/implementation-plan-task-board-v1.md"]`
- **Path format:** Use `docs/...` relative paths for knowledge documents, full `https://` URLs for external links.
- **Soft links:** References are not validated — if a referenced file is moved or deleted, the link simply becomes stale. This is acceptable; don't let it block task operations.

## Assign Auto-Activation

When you `create_task` or `update_task` with an `assignee` who is an agent in the room, **that agent is automatically activated** and receives the task context (title, description, references). This replaces the need to send a separate `@mention` message.

- Assigning to a human user (e.g., "fish") does not trigger activation
- Assigning to yourself does not trigger activation (prevents self-loops)

**When to use task assign vs chat mention:**
- Need structured context (title + description + references) → create/update task with assignee
- Quick clarification or ad-hoc discussion → chat mention

## Tasks Are Living Records

A task description is not just the original request — it grows as work progresses. Each actor that takes over a task should add their output to the description:

| Actor takes the task | What they append |
|----------------------|-----------------|
| Designer of the approach | Implementation plan, key decisions, risks |
| Implementer | What was built, file changes, commits, known limitations |
| Verifier | Test results, acceptance scope, defects found |

Use `update_task` with `description=` to append (preserve previous content; don't overwrite).

This makes task.description the single record of the work — readable end-to-end without spelunking through chat history.

## Principles

- **Update proactively.** When you finish work, update the task status in the same message where you report completion. Don't make others chase you.
- **Tasks reflect reality.** If work is in progress, the task should say in-progress. If it's done, move it to done. Stale task states erode trust in the board.
- **Check the board before starting.** Use `list_tasks` to see what's already tracked before creating duplicates.

---

# Knowledge Discipline

Knowledge documents are the team's long-term memory. Sessions are ephemeral; knowledge persists.

## Structure

Organize documents by project, then by type:

```
docs/
├── {project}/                # One directory per project
│   ├── architecture/         # Architecture maps, tech debt, key decisions
│   ├── prds/                 # Product requirements documents
│   ├── implementation-plans/ # Implementation plans for approved features
│   ├── qa/                   # Test plans, acceptance reports, test infra guides
│   ├── design/               # Design baselines, component specs, tokens
│   └── releases/             # Version specs, release notes
├── rules/                    # Cross-project rules (injected into system prompts)
```

When creating a document, place it in `{project}/{type}/`. Do not dump files in the root.

## Principles

- Before starting any task, read relevant knowledge documents. Do not assume your context is current.
- After completing work that changes system behavior, update affected knowledge documents.
- Each role maintains their own core documents. Keep them accurate — your teammates depend on them.
- When you discover information that others will need, write it down. Don't keep it in your session only.
