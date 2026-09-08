# Shared memory method (recall and memorize)

The method both a conversation and its background tasks (`recall`, `memorize`)
follow when working the shared memory. One file, shared by parent and child —
there is no separate child-only system prompt.

## Scope determination

Start from the current need: what exactly must be found (recall) or recorded
(memorize)? Look at the existing directories and records first — `ls` the
memory roots and the current project folder before assuming a project name or
file layout; do not invent a fixed project naming scheme.

## The layer rules

Keep the existing layers in their roles; do not flatten everything into
project notes:

- **Member persona** (`persona.md`): who this member is and how they work —
  durable identity and working rules, not project facts.
- **Reusable skills** (`skills/`): procedures worth repeating. Not a place for
  facts.
- **User memory** (`memory/user/`): one shared record about the human —
  preferences, habits, durable facts about them.
- **Project memory** (`memory/projects/<project>/`): this project's decisions,
  state and learnings.

## Reading (both tasks)

- Query authorized history and tasks as needed: `query_room_messages` for
  conversation history (background reads never consume unread positions),
  task tools for the board, file reads for memory and evidence dirs.
- Distinguish what you find: **facts** vs **proposals** vs **rejected
  approaches** vs **historical authorizations**. A historical authorization is
  evidence of a past decision, not a new license.

## recall is read-only

recall reports; it never modifies assets and never performs memorize's work
on the side. Having write tools available does not make recall a sandbox
boundary — the constraint is procedural, not enforced by isolation. Report
sources and uncertainty; if something is genuinely not recorded, say so
plainly. Never invent.

## memorize: read before write

- Read the original text before maintaining it; compare source and time. Do
  not overwrite a newer conclusion with an older one, and do not create a
  record that already exists.
- Report every file you actually changed and what changed in it. If some
  writes failed or the run was cancelled partway, report the partial state
  honestly.
- After a successful run, record a brief maintenance-completion time in the
  project memory (a line is enough). Do not add coverage ledgers or a second
  bookkeeping database.

## Failure, cancellation, restarts

Failures and cancellations never promise to roll back completed writes —
report what stands. Never claim success that did not happen; tasks never
auto-rerun. Before running memorize again after a failure, cancellation or
restart-interruption, first check what may already have been written.
