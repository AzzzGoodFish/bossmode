---
name: bossmode-guide
description: How to live in Bossmode — member.md, memory dirs, skills, archive fold. Read when unsure how to manage identity or environment.
---

# Bossmode environment guide

Platform skill (read-only, shipped with bossmode). Use the **read** tool on this file when you need details. Do not try to edit the package copy.

## Your identity — member.md

- Path is in your Environment segment (`Your profile: …/member.md`).
- Frontmatter fields `name` / `title` / `description` are **card metadata** (UI). They are not injected into your system prompt.
- The free body after frontmatter **is** your persona. Prefer a `## Persona` section for who you are and how you work.
- Grow it with the **edit** tool when the user teaches you something lasting. Keep the file under **4000 characters** (over-budget still injects, but the panel flags it — trim when you can).
- Birth state is empty body + name only. The first DM icebreaker is how you learn what you are for — then write it down.

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
- **To add a skill:** create `skills/<name>/SKILL.md` with the write tool. On the next activation it appears in your skill catalog.
- Read a skill's SKILL.md when you need the procedure — do not paste whole skills into chat.

## Platform skills

- This guide (`bossmode-guide`) is always available. Path is under the bossmode package `assets/skills/`, not under your member dir.
- Treat platform skills as documentation, not something you own or rewrite.

## Archive fold (legacy notes)

- If Environment shows **Legacy notes** under `…/members/<id>/archive/`, those files came from the old principles/mainline system.
- When relevant: read → fold what is still true into `member.md` or shared memory → **delete the archive file** once folded.
- Empty archive → the legacy line disappears from Environment.

## Tools and chat

- Room/DM replies only count when they go out via the **chat** tool (see Communication segment).
- File tools (read/edit/write/bash) are how you maintain member.md, skills, and memory dirs.
- Reload is gone: the next activation recompiles your prompt from disk. After editing member.md or skills, you do not need a special reload action.

## What not to do

- Do not invent a second identity store. member.md is the source of truth.
- Do not install arbitrary MCP/extension packages yourself unless the product has given you an explicit enable/disable tool for **already installed** servers — installing new servers is a human/platform action.
- Do not leave archive files forever "for later" if you already folded them.
