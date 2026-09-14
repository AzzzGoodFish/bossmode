# Shared memory method

How to work the shared memory — the `memory/user/` and `memory/projects/`
directories listed in your Environment segment. Plain files, ordinary tools:
`ls` and `read` to look, `write`/`edit` to maintain.

## Scope determination

Start from the current need: what exactly must be found or recorded? Look at the
existing directories and records first — `ls` the memory roots and the current
project folder before assuming a project name or file layout; do not invent a
fixed project naming scheme.

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

## Reading

- Query authorized history as needed: `chat_read` / `chat_search` for conversation
  history, file reads for memory and evidence dirs.
- Reading is read-only: looking things up never modifies assets as a side
  effect. Having write tools available does not change that discipline — it is
  procedural, not enforced by isolation.
- Distinguish what you find: **facts** vs **proposals** vs **rejected
  approaches** vs **historical authorizations**. A historical authorization is
  evidence of a past decision, not a new license.
- Report sources and uncertainty; if something is genuinely not recorded, say so
  plainly. Never invent.

## Writing: read before write

- Read the original text before maintaining it; compare source and time. Do not
  overwrite a newer conclusion with an older one, and do not create a record
  that already exists.
- Report every file you actually changed and what changed in it. If some writes
  failed or a turn was interrupted partway, report the partial state honestly.
  Writes are never rolled back: after an interruption, first check what may
  already have been written before repeating the pass.
- After a maintenance pass, record a brief completion time in the project
  memory (a line is enough). Do not add coverage ledgers or a second
  bookkeeping database.
