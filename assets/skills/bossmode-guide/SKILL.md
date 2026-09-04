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
   npm install pi-web-access
   ln -s node_modules/pi-web-access pi-web-access
   ```
   (If `extensions/` does not exist yet, `mkdir -p` it first.)
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
