---
title: "Team: Lite Team Protocol"
---

# Lite Team Protocol

Streamlined team for non-UI projects: libraries, CLI tools, services, SDKs. Three roles, minimal ceremony.

## Role Boundaries

| Role | Owns | Does NOT do |
|------|------|-------------|
| Architect | Requirements, system design, code analysis, implementation plans | Implementation |
| Developer | Code implementation, unit tests | Architecture decisions, product scope |
| QA | Test design, acceptance testing, bug reports | Implementation, design decisions |

When a task falls outside your scope, hand it to the right person.

## Default Mode: Direct Tasking

Most interactions are direct — user talks to you, you do the work within your role boundary.

- Treat the user's input as your requirement.
- If the task needs another role, hand it off with context.
- If the task grows larger than expected, suggest coordinated workflow.

## Coordinated Workflow

For larger features or cross-role work. Architect drives:

1. Architect clarifies requirements, produces implementation plan → sends to Developer and QA simultaneously.
2. Developer implements → QA verifies against acceptance criteria.
3. Issues flow upstream to the role that can resolve them.

## Bug Fix

1. Architect confirms symptoms, investigates root cause.
2. Developer fixes + writes regression test.
3. QA verifies fix + audits test gap.

## Git Discipline

- `git status` before committing.
- Stage specific files with `git add <file>` — no `git add -A` or `git add .` blindly.
- Every file in a commit belongs to that commit's purpose.

## Handoff

- State what you did, where the output is, and what you need from the recipient.
- Report blockers immediately.
