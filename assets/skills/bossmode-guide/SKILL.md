---
name: bossmode-guide
description: How to live in Bossmode — persona.md, your memory, skills, archive fold. Read when unsure how to manage identity or environment.
---

# Bossmode environment guide

Platform skill (read-only, shipped with bossmode). Use the **read** tool on this file when you need details. Do not try to edit the package copy.

## Your persona — persona.md

- Path is in your Assets chapter (`persona: …`).
- The entire file is your persona: plain Markdown, without frontmatter, a schema, or required headings.
- Your name, description, and structured member configuration live in Bossmode's database. Writing them as text in persona.md does not change those fields.
- Use `profile_update` to change your own name or description. Names are globally unique; `all`, `user`, and `system` are reserved. An empty description clears it. Use the committed name returned by the tool immediately; old names are not aliases. Your current turn and stable member ID are preserved.
- Grow the file with the **edit** tool when the user teaches you something lasting. Keep it under **4000 characters** (over-budget still injects, but the panel flags it — trim when you can).
- Birth state is an empty file. The first DM icebreaker is how you learn what you are for — then write it down.
- Use your current name when communicating; the stable member ID identifies your records and scope membership.

## Your memory (private)

Memory is **yours alone** — each member keeps their own, from their own view. It lives in `…/members/<your-id>/memory/` (path in your Assets chapter). Plain files, ordinary tools (`ls`, `read`, `write`, `edit`) — there is no separate memory tool.

- **Quality over quantity.** Keep what has been refined twice and holds reuse value. One-off thoughts, and anything chat history can easily replace, do not belong here.
- **Overview plus parts.** Keep an overview/index first, then files by topic — so a look finds it fast.
- Knowledge you want **other members** to see does not go here: write it into a document (the Library) or say it to them in chat.
- Read when the conversation leans on things you may not have at hand: decisions from earlier days, another room's outcome, the user's standing preferences. Look at what already exists before assuming a layout.
- Write at meaningful checkpoints — after a decision, after a repeated correction, at the end of substantial work — not after every exchange.
- Read before you write: do not overwrite a newer conclusion with an older one, and do not duplicate a record that already exists. Keep notes short and durable, and report what you changed.

The full method — placement rules, read-before-write, source discipline — lives in [references/memory.md](references/memory.md) next to this file.

For communication and decisions, search chat; for execution history, search your session archive; for reusable methods, read skills; for current preferences and project state, read your memory and the documents. See [references/sessions.md](references/sessions.md) for complete read-only session search commands, pagination, and the operator-only migration procedure.

## Your private skills directory

- Path: `…/members/<your-id>/skills/` (also listed in Assets when non-empty).
- Each skill is a folder with `SKILL.md` (optional frontmatter `description:`).
- **To add a skill:** create `skills/<name>/SKILL.md` with the write tool. Then call **reload** (or it applies on your next activation).
- Read a skill's SKILL.md when you need the procedure — do not paste whole skills into chat.

## Platform skills

- This guide (`bossmode-guide`) is always available. Path is under the bossmode package `assets/skills/`, not under your member dir.
- Treat platform skills as documentation, not something you own or rewrite.

## Archive fold (legacy notes)

- If your Assets chapter shows the **archive** line, those files came from the old system (old notes, old sessions).
- The archive holds `archive/sessions/…`: session files from the retired per-chat layout, kept readable but never resumed. Leave them alone; search them with the session-search script when you need old history.
- When relevant: read → fold what is still true into `persona.md` or your own memory → **delete the archive file** once folded (never delete `archive/sessions/`).
- Empty archive → the archive line disappears from Assets.

## Your MCP servers and extensions

- Your MCP servers live in `…/members/<your-id>/mcp.json` (file present = enabled, all servers in it).
- Your extensions live in `…/members/<your-id>/extensions/` — this directory is the ONLY extension source. There is no platform-level extension store anymore (pi-mcp-adapter is built in and invisible to you).
- **To configure:** edit these files directly with the file tools. Then call the `reload` tool to apply.

## Installing an extension package yourself (e.g. web search)

Web search / subagents are NOT preinstalled anymore. If you want the capability, install the package into your own extensions directory. Concrete steps (web search via `pi-web-access` as the example):

1. Find your member id from Assets (`…/members/<your-id>/`), then open a terminal:
   ```
   terminal_create
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

## Terminals (persistent)

- `terminal_create` opens a real terminal (workspace defaults to the active one). Your cwd, environment, and long-running processes (dev servers, watchers) persist between tool calls — no more one-shot bash.
- **Set things once, they stay.** Do not re-`cd` or re-`export` on every command — the terminal remembers. `cd` only when you actually want to work somewhere else. New terminals start with a clean environment (your dotfiles are NOT loaded): set up what you need (nvm, PATH additions, credentials) once per terminal, then it persists for the terminal's whole life.
- `terminal_exec` returns the command's exact output with exit code and line range (`exec` id like `e3`, plus lineStart/lineEnd). Commands still running after 10s return as running — pick up the rest later with `terminal_read` (by exec id or line numbers; line numbers are the stable reference). For servers or long builds, pass `blockUntilMs: 0` to background immediately instead of waiting out the 10s.
- **One command at a time per terminal.** While a terminal is still running a command, a new command is rejected — the error tells you the current exec id; your new command is NOT submitted and NOT queued. Wait with `terminal_wait`, read what's there with `terminal_read`, stop the old command with `keys:"ctrl-c"`, or create another terminal for independent work (different terminals run in parallel).
- `keys` sends control keys: `ctrl-c`, `ctrl-z`, `ctrl-d`.
- When a command changes the working directory, its result ends with a receipt line like `cwd: /old → /new` — that is your confirmation the cd took effect and will persist. No receipt line means the cwd is unchanged.
- `terminal_wait({terminalId, exec, blockUntilMs?})` blocks until that command finishes (default 30s; `blockUntilMs: 0` waits until completion). Done returns exit code + line range + output; a timeout returns running with the progress so far. Use it after an interruption: the synthesized tool result tells you the exec id — finish your new task, then `terminal_wait` for the original command.
- Terminals are yours across rooms and DMs. They live only in memory — after a daemon restart they are gone; create new ones. Dead terminals report honestly — close them with `terminal_close`.
- Limits: full-screen programs (top, less) render badly at 160×1000 and are not supported. A shell process started inside a terminal (running `bash` or `ssh`) does not emit completion markers — the outer command shows as running until the inner shell exits.
- If a new message interrupts you mid-turn, your run is aborted and the message is processed immediately (the envelope says so). Commands in terminals are NOT killed: the interrupted `terminal_exec` gets a tool result like "still running as exec e5 — wait for it with terminal_wait". Finish handling the new message, then `terminal_wait` for the original command and read its output.
- The one-shot `bash` tool is gone; file tools and terminals cover everything it did.

## Your MCP servers and extensions — CJS note

- If you write an extension as plain JavaScript (CommonJS), the factory export must be `module.exports = function (pi) { … }`. Writing `exports.default = fn` fails pi's factory validation ("does not export a valid factory function"). ESM files use `export default`.

## Reload (apply asset changes)

- After editing `persona.md`, your skills, `mcp.json`, or `extensions/`, call the zero-argument **reload** tool to rebuild your session with fresh assets.
- Conversation history is preserved — reload is not a reset. Reset (staff action) starts a new session file; the previous JSONL stays where it is in your session store (`sessions/<day>/main/`) and remains searchable. Reload keeps using the current session.
- Mid-run: reload queues and applies when your current turn finishes.

## Tools and chat

- Room/DM replies only count when they go out via `chat_send` (see the Communication chapter).
- File tools (read/edit/write) and persistent terminals are how you maintain persona.md, skills, your memory, and anything else.

## What not to do

- Do not invent a second identity store. The database owns structured member identity; persona.md owns your persona.
- Your own `mcp.json` and `extensions/` are yours to manage — but only add MCP servers and extensions you understand and trust. Anything that runs commands or fetches content can act with your full tool access.
- Do not leave archive files forever "for later" if you already folded them.
