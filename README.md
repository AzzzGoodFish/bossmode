# Bossmode

> Discord-style AI team command center — manage your AI agents like a team.

Bossmode lets you run a collaborative workspace where you and multiple AI agents work together in chat rooms. Mention an agent to activate it, watch it think and use tools, steer it mid-task, and build up shared knowledge across your team.

![Bossmode main interface](bossmode-main.png)

---

## Concept

| You are | Your agents are |
|---------|----------------|
| The boss | The employees |
| Giving direction | Doing the work |
| Setting context | Building knowledge |

**Agent** = a role definition (PM, developer, architect…)  
**Member** = an agent assigned to a model configuration  
**Room** = a project workspace where you and members collaborate  
**Knowledge** = shared context injected into agent prompts

---

## Install

```bash
npm install -g bossmode
```

**Requirements**:
- Node.js ≥ 20.6

Bossmode bundles the pi Agent SDK runtime via npm dependencies; a separate global `pi` CLI install is not required for normal use.

---

## Quick Start

```bash
# Start the server (default: http://localhost:8080)
bossmode on

# Custom host/port
bossmode on --host 0.0.0.0 --port 12521

# Check status
bossmode status

# Stop
bossmode off
```

Open your browser at `http://localhost:8080` and sign in. On first run, `bossmode on` will prompt you to set a username and password.

---

## Features

### 💬 Chat Rooms
- Create project rooms with custom names and working directories
- Group chat: mention agents with `@name` or broadcast to all with `@all`
- Real-time streaming — watch agents think and respond live
- Message history with pagination
- Rename and delete rooms

### 🤖 Agent Activity (Private Chat)
- Click any active agent to see its internal work: tool calls, thinking, tool results
- Send private **steer** instructions mid-task without posting to the group
- Restart a stuck agent instance without leaving the room

### 👥 Members
- Create members by combining an agent definition + model
- Configure per-member: thinking level (`off` / `minimal` / `low` / `medium` / `high` / `xhigh`), context limit, and skills
- Members persist across rooms and can be added to any room

### 🧠 Agent Definitions
- Agents are defined in Markdown with YAML frontmatter
- Built-in templates: `pm`, `architect`, `developer`, `qa`, `designer`, `summarizer`
- Create custom agents with any role, persona, and skill set

### 🛠️ Skills
- Skills are capability documents injected into agent prompts
- Create custom skills for your domain
- Attach files (reference docs, style guides, etc.) to skills

### 📚 Knowledge Base
- Store project context, decisions, and conventions
- Two types: **knowledge** (background info) and **rule** (collaboration norms, selectively injected)
- Agents can create, query, update, and delete knowledge entries via tools

### 📝 Smart Summarization
- Summarize accumulated messages into topic-based AI summaries
- Summaries replace original messages in agent context, expanding effective context window
- Expand any summary card to read the original messages
- Configure auto-summarization threshold in Settings

### ⚙️ Settings
- **Model Credentials**: connect official providers, enable/disable Connect Provider catalog models, override Connect Provider context windows, add custom endpoints, and edit custom model context/output limits
- **Session Resume**: toggle whether agents resume prior pi SDK sessions
- **Auto-Summary**: enable automatic summarization with configurable threshold and keep count

---

## Agent Tools

Agents have access to these tools via MCP:

| Tool | Description |
|------|-------------|
| `chat` | Post a message to the room or a private reply; auto-parses `@mentions` from content |
| `query_room_messages` | Read recent room message history |
| `save_knowledge` | Create a new knowledge entry |
| `query_knowledge` | Query knowledge base (no args returns index; with query returns matching entries) |
| `update_knowledge` | Update an existing knowledge entry |
| `delete_knowledge` | Delete a knowledge entry |
| `write_summary` | (summarizer only) Write a topic-based summary covering a message range |

---

## Architecture Overview

Bossmode is a single Node.js daemon: HTTP static serving + REST API + WebSocket real-time push + in-process pi Agent SDK runtime. No external database — everything is stored on the file system.

```
┌─────────────────────────────────────────────────────────────┐
│                      User (Browser)                          │
└──────────────────────┬──────────────────────────────────────┘
                       │  HTTP + WebSocket
┌──────────────────────▼──────────────────────────────────────┐
│                  Bossmode Daemon (single process)            │
│                                                              │
│   ┌─────────┐  ┌───────────────┐  ┌──────────────────────┐  │
│   │   API   │→ │ Communication │→ │       Engine         │  │
│   │ (REST)  │  │ message-bus + │  │ agent-manager +      │  │
│   │         │  │ router + ws   │  │ prompt-assembler +   │  │
│   └─────────┘  └───────────────┘  │ runtime registry     │  │
│                                   └──────────┬───────────┘  │
│   ┌────────────────────────────────────┐     │              │
│   │  Store (file system)               │     │              │
│   │  workforce/ + workspace/ +         │     │              │
│   │  knowledge/                        │     │              │
│   └────────────────────────────────────┘     │              │
└──────────────────────────────────────────────┼──────────────┘
                                               │ in-process
                              ┌─────────────────┐
                              │ pi Agent SDK    │
                              │   (runtime)     │
                              └─────────────────┘
```

**Five core domains**:

| Domain | Responsibility | Key entities |
|--------|---------------|--------------|
| **Workforce** | Who does the work | Agent (definition), Skill (capability), Member (model assignment) |
| **Workspace** | Where the work happens | Room, Message, Archive, Session |
| **Knowledge** | Background context | Knowledge Entry, Rule |
| **Communication** | How messages flow | message-bus, router (@mention parsing), WebSocket |
| **Engine** | How agents run | agent-manager, prompt-assembler, runtime registry |

Dependency direction is strictly one-way: `API → Communication → Engine → Store`. No circular dependencies.

### Supported Runtimes

Bossmode uses the in-process `@earendil-works/pi-coding-agent` SDK runtime, installed as an npm dependency of Bossmode.

| Runtime | Install | Notes |
|---------|---------|-------|
| **pi SDK** | Bundled dependency | Multi-provider agent runtime with streaming, tool events, thinking levels, session resume, context usage tracking, and dynamic model/thinking configuration |

Bossmode provides its own tools directly to the SDK runtime.

### Data Storage

All data lives in `~/.bossmode/` — plain text and JSON, easy to back up and migrate:

```
~/.bossmode/
├── config.json              # Global settings (credentials, port, runtime config)
├── bossmode.pid             # Daemon process PID
├── bossmode.log             # Server log
├── members.json             # Member configurations (model assignments)
├── agents/                  # Custom agent definitions (override built-in templates)
│   └── *.md                 #   Markdown + YAML frontmatter
├── skills/                  # Custom skill documents
│   └── <skill-name>/
│       └── SKILL.md
├── knowledge/               # Knowledge base
│   └── <kb-id>/
│       ├── meta.json
│       └── entries/*.json
└── rooms/                   # Chat rooms
    └── <room-id>/
        ├── room.json        # Room metadata, members, cursors
        ├── messages.jsonl   # Message stream (includes summary messages)
        ├── sessions.json    # Per-agent runtime session mapping
        └── archives/        # Legacy archives (superseded by summarization)
```

`config.json` contains hashed credentials. All other files are plain text.

---

## Configuration

On first run, `bossmode on` will prompt you interactively to set a username and password. Credentials are hashed and stored in `~/.bossmode/config.json`.

Optional environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `BOSSMODE_HOST` | Server bind host | `127.0.0.1` |
| `BOSSMODE_PORT` | Server port | `8080` |
| `BOSSMODE_DIR` | Data directory | `~/.bossmode` |

Host and port can also be set via `--host` / `--port` flags on `bossmode on`.

Model credentials are managed in Settings. Official providers use the bundled pi SDK catalog; custom endpoints can edit per-model context window and max output token limits, while blank API key fields preserve existing saved secrets on edit. Bossmode preserves SDK model metadata such as context windows, output limits, reasoning capability, and provider compatibility flags for models like Claude Fable 5. When a member switches across credentials or providers, Bossmode recreates the SDK handle with session resume so fresh auth is loaded without losing conversation context.

---

## Development

```bash
# Clone and install
git clone https://github.com/AzzzGoodFish/bossmode.git
cd bossmode
npm install
cd web && npm install && cd ..

# Build
npm run build

# Run tests
npm test

# Dev mode (TypeScript watch)
npm run dev
```

---

## License

ISC
