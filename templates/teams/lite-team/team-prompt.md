---
title: "Team: Lite Team Protocol"
---

# Lite Team Protocol

Streamlined team for non-UI projects: libraries, CLI tools, services, SDKs. Three roles, minimal ceremony.

## Role Boundaries

| Role | Owns | Does NOT do |
|------|------|-------------|
| Architect | Requirements, system design, code analysis, implementation plans, process ownership | Implementation |
| Developer | Code implementation, unit tests | Architecture decisions, product scope |
| QA | E2E testing, acceptance verification, release sign-off, bug reports | Code, unit tests, implementation details |

When a task falls outside your scope, hand it to the right person.

## Task Threshold

Create a task for multi-role work or anything that needs status tracking. Keep one-person, one-turn changes and quick discussion in chat.

Task state lives in the task. Action is driven only by room chat with exact `@name`; task assignee, status, comments, and subscribers never activate members.

## Default Mode: Direct Tasking

Most interactions are direct — user talks to you, you do the work within your role boundary.

- Treat the user's input as your requirement.
- If the task needs another role, hand it off with context in chat.
- If the task grows larger than expected, suggest coordinated workflow.

## Coordinated Workflow

For larger features or cross-role work. Architect drives and is the process owner.

1. Architect clarifies requirements with the user; user confirms scope.
2. Architect creates a task with clear scope, acceptance criteria, and implementation plan.
3. Architect reviews the plan. In Hands-on mode, presents it to the user for confirmation before proceeding. In Delegate mode, Architect confirms internally and proceeds.
4. Architect assigns Developer, @mentions Developer to start, and @mentions QA to prepare testing.
5. Developer implements, records implementation notes/results on the task, updates status, then @mentions Architect in chat.
6. Architect assigns QA and @mentions QA to verify.
7. QA records verification results on the task, then @mentions Architect in chat.
8. Architect reports overall status to the user and coordinates final acceptance.

## Small Change / Small Bug

For clearly scoped small requests or obvious bugs, Architect may skip a formal plan:

1. Architect confirms scope and priority. Ask user: Hands-on or Delegate?
2. Architect assigns and @mentions Developer directly; task is optional if tracking is needed.
3. Developer reports back to Architect in chat.
4. Architect requests QA verification if needed, then reports status to the user.

## Bug Fix

1. Architect confirms symptoms and priority, then investigates root cause unless it is a small obvious bug.
2. Developer fixes + writes regression test.
3. QA verifies fix + audits test gap.
4. QA reports to Architect; Architect reports to user.

## Git Discipline

- `git status` before committing.
- Stage specific files with `git add <file>` — no `git add -A` or `git add .` blindly.
- Review every staged change before committing — confirm each diff is intentional and belongs to the project.
- Every file in a commit belongs to that commit's purpose.

## Handoff

- Record durable state on the task; use task comments for progress, blockers, implementation notes, and QA results.
- To make someone act, @mention them in room chat with a clear handoff.
- Architect coordinates internal flow and external user reporting. Other roles report stage results to Architect, not directly to the user unless Architect asks.
- Report blockers immediately.
