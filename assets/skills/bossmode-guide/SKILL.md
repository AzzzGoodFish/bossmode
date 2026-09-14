---
name: bossmode-guide
description: How to live in Bossmode — persona.md, memory dirs, skills, archive fold. Read when unsure how to manage identity or environment.
---

# Bossmode environment guide

Platform skill (read-only, shipped with bossmode). Use the **read** tool on this file when you need details. Do not try to edit the package copy.

## Your persona — persona.md

- Path is in your Environment segment (`Your profile: …/persona.md`).
- The entire file is your persona: plain Markdown, without frontmatter, a schema, or required headings.
- Your name, title, and structured member configuration live in Bossmode's database. Writing them as text in persona.md does not change those fields.
- Use `update_profile` to change your own name or title. Names are globally unique; `all`, `user`, and `system` are reserved. An empty title clears it. Use the committed name returned by the tool immediately; old names are not aliases. Your current turn and stable member ID are preserved.
- Grow the file with the **edit** tool when the user teaches you something lasting. Keep it under **4000 characters** (over-budget still injects, but the panel flags it — trim when you can).
- Birth state is an empty file. The first DM icebreaker is how you learn what you are for — then write it down.
- Use the current name shown in your environment for communication; the stable member ID identifies your records and scope membership.

## Shared memory (not injected)

Listed in Environment. **ls / read on demand**; write back what should stick.

| Path | What lives there |
|------|------------------|
| `…/memory/user/` | One shared record about the human: preferences, habits, durable facts. |
| `…/memory/projects/` | One folder per project. ls before project work; write project learnings back. |

Do not dump session noise here. Prefer short, durable notes.

For communication and decisions, search chat; for execution history, search your session archive; for reusable methods, read skills; for current preferences and project state, read memory. See [references/sessions.md](references/sessions.md) for complete read-only session search commands, pagination, and the operator-only migration procedure.

**Working it.** Use the ordinary file tools (`ls`, `read`, `write`, `edit`) — there is no separate memory tool.

- Read when the conversation leans on things you may not have at hand: decisions from earlier days, another room's outcome, the user's standing preferences. Look at what already exists — `ls` the memory roots and the current project folder — before assuming a project name or file layout.
- Write at meaningful checkpoints — after a decision, after a repeated correction, at the end of substantial work — not after every exchange. Put durable facts on the right layer: user memory for who the user is and how they work; the room's project folder for decisions and project state.
- Read before you write: do not overwrite a newer conclusion with an older one, and do not duplicate a record that already exists. Keep notes short and durable, and report what you changed.
- The full method — layer rules, read-before-write, source discipline — lives in `references/memory.md` next to this file.

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
- When relevant: read → fold what is still true into `persona.md` or shared memory → **delete the archive file** once folded.
- Empty archive → the legacy line disappears from Environment.

## Your MCP servers and extensions

- Your MCP servers live in `…/members/<your-id>/mcp.json` (file present = enabled, all servers in it).
- Your extensions live in `…/members/<your-id>/extensions/` — this directory is the ONLY extension source. There is no platform-level extension store anymore (pi-mcp-adapter is built in and invisible to you).
- **To configure:** edit these files directly with the file tools. Then call the `reload` tool to apply.

## Installing an extension package yourself (e.g. web search)

Web search / subagents are NOT preinstalled anymore. If you want the capability, install the package into your own extensions directory. Concrete steps (web search via `pi-web-access` as the example):

1. Find your member id from Environment (`…/members/<your-id>/`), then open a shell:
   ```
   shell_create
   ```
2. Install the npm package into your extensions dir and link it where the loader sees it:
   ```
   cd ~/.bossmode/members/<your-id>/extensions
   npm init -y
   npm install pi-web-access
   ln -s node_modules/pi-web-access pi-web-access
   ```
   (`npm init -y` first is required: without a local package.json, npm walks up the directory tree looking for an install root and can fail (EACCES) or silently install somewhere else. If `extensions/` does not exist yet, `mkdir -p` it before these steps.)
3. Call the **reload** tool (zero arguments). Your session rebuilds with the new extension.
4. Verify: `web_search` (or the package's tools) appears in your tool list / Assets panel. If a key is required (e.g. an Exa key), put it where the package's README says — for pi-web-access that is `~/.pi/web-search.json`.

What the loader accepts in `extensions/`: plain `.ts`/`.js` files at the root, and any subdirectory (or symlink to one) that has `index.ts`/`index.js` or a `package.json` with a `pi.extensions` list. The symlink trick above works because npm packages carry their own `package.json` with `pi.extensions`.

To uninstall: delete the symlink (and `npm uninstall` if you want the files gone), then reload.

## Workspaces (where relative paths resolve)

- You always have the builtin workspace `original` — this whole machine, root = your member directory. It cannot be removed.
- Register remote machines yourself: `workspace_create` with id, host, user (ssh). Your own ssh key (`…/members/<your-id>/ssh/id_ed25519`) is used by default — give its `.pub` line to the machine's authorized_keys to grant yourself access. Never paste the private key into chat or send it anywhere.
- `workspace_use` switches the active workspace; relative paths in read/write/edit (and new sessions) follow it. File tools also take a `workspace` parameter to target any workspace by id without switching.

## Shells (persistent terminals)

- `shell_create` opens a real terminal (workspace defaults to the active one). Your cwd, environment, and long-running processes (dev servers, watchers) persist between tool calls — no more one-shot bash.
- **Set things once, they stay.** Do not re-`cd` or re-`export` on every command — the shell remembers. `cd` only when you actually want to work somewhere else. New shells start with a clean environment (your dotfiles are NOT loaded): set up what you need (nvm, PATH additions, credentials) once per new shell, then it persists for the shell's whole life.
- `shell_exec` returns the command's exact output with exit code and line range (`exec` id like `e3`, plus lineStart/lineEnd). Commands still running after 10s return as running — pick up the rest later with `shell_read` (by exec id or line numbers; line numbers are the stable reference). For servers or long builds, pass `blockUntilMs: 0` to background immediately instead of waiting out the 10s.
- **One command at a time per shell.** While a shell is still running a command, a new command is rejected — the error tells you the current exec id; your new command is NOT submitted and NOT queued. Wait with `shell_wait`, read what's there with `shell_read`, stop the old command with `keys:"ctrl-c"`, or create another shell for independent work (different shells run in parallel).
- `keys` sends control keys: `ctrl-c`, `ctrl-z`, `ctrl-d`.
- When a command changes the working directory, its result ends with a receipt line like `cwd: /old → /new` — that is your confirmation the cd took effect and will persist. No receipt line means the cwd is unchanged.
- `shell_wait({shell, exec, blockUntilMs?})` blocks until that command finishes (default 30s; `blockUntilMs: 0` waits until completion). Done returns exit code + line range + output; a timeout returns running with the progress so far. Use it after an interruption: the synthesized tool result tells you the exec id — finish your new task, then `shell_wait` for the original command.
- Shells are yours across rooms and DMs. They live only in memory — after a daemon restart they are gone; create new ones. Dead shells report honestly — close them with `shell_close`.
- Limits: full-screen programs (top, less) render badly at 160×1000 and are not supported. A shell started inside a shell (running `bash` or `ssh` inside your shell) does not emit completion markers — the outer command shows as running until the inner shell exits.
- If a new message interrupts you mid-turn, your run is aborted and the message is processed immediately (the envelope says so). Shell commands are NOT killed: the interrupted `shell_exec` gets a tool result like "still running as exec e5 — wait for it with shell_wait". Finish handling the new message, then `shell_wait` for the original command and read its output.
- The one-shot `bash` tool is gone; file tools and shells cover everything it did.

## Your MCP servers and extensions — CJS note

- If you write an extension as plain JavaScript (CommonJS), the factory export must be `module.exports = function (pi) { … }`. Writing `exports.default = fn` fails pi's factory validation ("does not export a valid factory function"). ESM files use `export default`.

## Reload (apply asset changes)

- After editing `persona.md`, your skills, `mcp.json`, or `extensions/`, call the zero-argument **reload** tool to rebuild your session with fresh assets.
- Conversation history is preserved — reload is not a reset. Reset (staff action) starts a new current session but preserves the prior SDK JSONL in your archive; reload keeps using the current session.
- Mid-run: reload queues and applies when your current turn finishes.

## Tools and chat

- Room/DM replies only count when they go out via the **chat** tool (see Communication segment).
- File tools (read/edit/write) and persistent shells are how you maintain persona.md, skills, memory dirs, and anything else.

## What not to do

- Do not invent a second identity store. The database owns structured member identity; persona.md owns your persona.
- Your own `mcp.json` and `extensions/` are yours to manage — but only add MCP servers and extensions you understand and trust. Anything that runs commands or fetches content can act with your full tool access.
- Do not leave archive files forever "for later" if you already folded them.
