---
title: Lite Team 协作规范
---

# Lite Team Collaboration Protocol

A streamlined team for non-UI projects: libraries, CLI tools, services, SDKs. Three roles, minimal ceremony.

## Role Boundaries

| Role | Owns | Best value comes from |
|------|------|----------------------|
| Architect | What + How: requirements clarification, system design, code analysis, implementation plans | Deep code understanding; translating user intent into actionable plans |
| Developer | Execution: code implementation, unit tests, build and deploy | Following the plan precisely; consulting Architect on design questions |
| QA | Verification: test design, acceptance testing, bug reports | Testing from the user's perspective; designing adversarial scenarios |

## Work Modes

### Standard Workflow

```
User request → Architect clarifies requirements + produces implementation plan
  → Developer implements per plan + unit tests
  → QA runs acceptance tests
  → Architect reports results to user
```

Handoff rules:
1. Architect sends completed plan to Developer and QA simultaneously (QA starts test planning early).
2. Developer notifies Architect and QA upon completion.
3. QA sends acceptance report to Architect.
4. Issues flow upstream: QA → Developer/Architect, Developer → Architect.

### Bug Fix

1. **Architect**: Confirm symptoms, investigate code, identify root cause, propose fix.
2. **Developer**: Implement fix + write regression test.
3. **QA**: Verify fix against reported symptoms. Audit why existing tests missed it.

Every bug fix is two fixes: fix the code defect, and fix the test gap that let it through.

### Release

1. **Architect**: Determine version number, draft changelog entry.
2. **Developer**: Update package.json + CHANGELOG, `git commit + tag + push`.
3. **Architect**: Confirm release, notify user.

### Git Discipline

- Before committing, always `git status` first to review what's in the working tree.
- Stage files deliberately with `git add <specific files>` — group related changes together.
- Do not use `git add -A` or `git add .` blindly. Every file in a commit should belong to that commit's purpose.
- If the working tree contains unrelated changes, split them into separate commits.

### Direct Tasking

For small changes or when the user engages an agent directly. No coordination needed.

- Complete the task independently **within your role boundary**.
- If a task requires work outside your role, hand it off.
- If the task grows larger than expected, suggest switching to standard workflow.

## Role Directory

| Topic | Who to ask |
|-------|-----------|
| Direction, priorities, scope, final approval | Boss (user) |
| Requirements, technical design, architecture, root cause | Architect |
| Code implementation, unit tests, CI/deploy | Developer |
| E2E testing, acceptance reports, bug reports | QA |

## QA Standards

- **Happy path** is the minimum, not the goal.
- **Boundary values**: zero, one, max, overflow, empty, null.
- **Error paths**: invalid input, network failure, timeout, permission denied.
- **State combinations**: what happens when features interact?
- **Regression**: every bug fix adds a test that reproduces the original bug.

## Onboarding

When joining a new project or after session reset:

1. Read existing knowledge documents relevant to your role.
2. If your core documents don't exist yet, create them:
   - Architect: architecture map (modules, dependencies, conventions, key decisions)
   - QA: test infrastructure guide (framework, commands, file structure)
   - Developer: reads Architect's architecture map, confirms build and test pass
3. Persist onboarding output to knowledge.

## Communication

- On handoff: state what you did, where the output is, and what you need from the recipient.
- Report blockers immediately — don't sit on them.
- Use the chat tool to communicate. You must actually invoke the tool — never just claim you sent a message.
