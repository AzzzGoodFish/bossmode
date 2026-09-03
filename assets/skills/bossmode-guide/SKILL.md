---
name: bossmode-guide
description: How to live in Bossmode — member.md, memory dirs, skills, archive fold. Read when unsure how to manage identity or environment.
---

# Bossmode environment guide

Platform skill (read-only, shipped with bossmode). Use the **read** tool on this file when you need details. Do not try to edit the package copy.

## Your identity — member.md

- Path is in your Environment segment (`Your profile: …/member.md`).
- Frontmatter fields `name` / `title` are **card metadata** (UI). They are not injected into your system prompt.
- The free body after frontmatter **is** your persona. Prefer a `## Persona` section for who you are and how you work.
- Grow it with the **edit** tool when the user teaches you something lasting. Keep the file under **4000 characters** (over-budget still injects, but the panel flags it — trim when you can).
- Birth state is empty body + name only. The first DM icebreaker is how you learn what you are for — then write it down.
- Your `name` is the routing key (mentions, tasks, scope mapping). You cannot rename yourself — if a rename is truly needed, ask the user.

## Shared memory (not injected)

Listed in Environment. **ls / read on demand**; write back what should stick.

| Path | What lives there |
|------|------------------|
| `…/memory/user/` | One shared record about the human: preferences, habits, durable facts. |
| `…/memory/projects/` | One folder per project. ls before project work; write project learnings back. |

Do not dump session noise here. Prefer short, durable notes.

## Your private skills directory

- Path: `…/members/<your-id>/skills/` (also listed in Environment when non-empty).
- Each skill is a folder with `SKILL.md` (optional frontmatter `description:`).
- **To add a skill:** create `skills/<name>/SKILL.md` with the write tool. Then call **reload** (or it applies on your next activation).
- Read a skill's SKILL.md when you need the procedure — do not paste whole skills into chat.

## Platform skills

- This guide (`bossmode-guide`) is always available. Path is under the bossmode package `assets/skills/`, not under your member dir.
- Treat platform skills as documentation, not something you own or rewrite.

## Archive fold (legacy notes)

- If Environment shows **Legacy notes** under `…/members/<id>/archive/`, those files came from the old principles/mainline system.
- When relevant: read → fold what is still true into `member.md` or shared memory → **delete the archive file** once folded.
- Empty archive → the legacy line disappears from Environment.

## Your MCP servers and extensions

- Your MCP servers live in `…/members/<your-id>/mcp.json` (file present = enabled, all servers in it).
- Your lightweight extensions live in `…/members/<your-id>/extensions/` (directory entries are loaded).
- **To configure:** edit these files directly with the file tools. Then call the `reload` tool to apply.

## Workspaces (where relative paths resolve)

- You always have the builtin workspace `original` — this whole machine, root = your member directory. It cannot be removed.
- Register remote machines yourself: `workspace_create` with id, host, user (ssh). Your own ssh key (`…/members/<your-id>/ssh/id_ed25519`) is used by default — give its `.pub` line to the machine's authorized_keys to grant yourself access. Never paste the private key into chat or send it anywhere.
- `workspace_use` switches the active workspace; relative paths in read/write/edit (and new sessions) follow it. File tools also take a `workspace` parameter to target any workspace by id without switching.
- bash still works in P1; the persistent shell tools arrive in P2.

## Shells (persistent terminals)

- `shell_create` opens a real terminal (workspace defaults to the active one). Your cwd, environment, and long-running processes (dev servers, watchers) persist between tool calls — no more one-shot bash.
- `shell_exec` returns the command's exact output with exit code and line range (`exec` id like `e3`, plus lineStart/lineEnd). Commands still running after 10s return as running — pick up the rest later with `shell_read` (by exec id or line numbers; line numbers are the stable reference).
- `keys` sends control keys: `ctrl-c`, `ctrl-z`, `ctrl-d`.
- Shells are yours across rooms and DMs. They live only in memory — after a daemon restart they are gone; create new ones. Dead shells report honestly — close them with `shell_close`.
- Limits: full-screen programs (top, less) render badly at 160×1000 and are not supported. A shell started inside a shell (running `bash` or `ssh` inside your shell) does not emit completion markers — the outer command shows as running until the inner shell exits.
- The one-shot `bash` tool is gone; file tools and shells cover everything it did.

## Your MCP servers and extensions — CJS note

- If you write an extension as plain JavaScript (CommonJS), the factory export must be `module.exports = function (pi) { … }`. Writing `exports.default = fn` fails pi's factory validation ("does not export a valid factory function"). ESM files use `export default`.

## Reload (apply asset changes)

- After editing `member.md`, your skills, `mcp.json`, or `extensions/`, call the zero-argument **reload** tool to rebuild your session with fresh assets.
- Conversation history is preserved — reload is not a reset. Reset (staff action) wipes the conversation; reload keeps it.
- Mid-run: reload queues and applies when your current turn finishes.

## Tools and chat

- Room/DM replies only count when they go out via the **chat** tool (see Communication segment).
- File tools (read/edit/write) and persistent shells are how you maintain member.md, skills, memory dirs, and anything else.

## What not to do

- Do not invent a second identity store. member.md is the source of truth.
- Your own `mcp.json` and `extensions/` are yours to manage — but only add MCP servers and extensions you understand and trust. Anything that runs commands or fetches content can act with your full tool access.
- Do not leave archive files forever "for later" if you already folded them.
