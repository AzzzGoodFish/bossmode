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
**Member** = an agent assigned to a runtime + model configuration  
**Room** = a project workspace where you and members collaborate  
**Knowledge** = shared context injected into agent prompts

---

## Install

```bash
npm install -g bossmode
```

**Requirements**:
- Node.js ≥ 18
- At least one agent runtime: [pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) or [claude-cli](https://docs.claude.com/claude-code) (Claude Code)

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
- Create members by combining an agent definition + runtime + model
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
- **Session Resume**: toggle whether agents resume prior runtime sessions (applies to all runtimes)
- **Auto-Summary**: enable automatic summarization with configurable threshold and keep count
- Runtime status: see detected runtimes and their capabilities

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

Bossmode is a single Node.js daemon: HTTP static serving + REST API + WebSocket real-time push + agent process pool. No external database — everything is stored on the file system.

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
                                               │ spawn
                              ┌────────────────┴────────────────┐
                              ▼                                 ▼
                     ┌─────────────────┐               ┌─────────────────┐
                     │    pi-cli       │               │   claude-cli    │
                     │   (runtime)     │               │   (runtime)     │
                     └─────────────────┘               └─────────────────┘
```

**Five core domains**:

| Domain | Responsibility | Key entities |
|--------|---------------|--------------|
| **Workforce** | Who does the work | Agent (definition), Skill (capability), Member (runtime assignment) |
| **Workspace** | Where the work happens | Room, Message, Archive, Session |
| **Knowledge** | Background context | Knowledge Entry, Rule |
| **Communication** | How messages flow | message-bus, router (@mention parsing), WebSocket |
| **Engine** | How agents run | agent-manager, prompt-assembler, runtime registry |

Dependency direction is strictly one-way: `API → Communication → Engine → Store`. No circular dependencies.

### Supported Runtimes

Bossmode does not bundle an LLM engine — it spawns external CLI runtimes. At least one must be installed.

| Runtime | Command | Install | Notes |
|---------|---------|---------|-------|
| **pi-cli** | `pi` | `npm install -g @mariozechner/pi-coding-agent` | Open-source multi-provider agent runtime |
| **claude-cli** | `claude` | [Anthropic docs](https://docs.claude.com/claude-code) | Claude Code CLI with MCP + Sessions + Hooks |

Both runtimes support the same capability set: streaming, tool events, thinking levels, session resume, context usage tracking, and dynamic model/thinking configuration.

Agent tools are injected via each runtime's native mechanism — pi-cli uses a JS extension, claude-cli uses an MCP HTTP server hosted on the main process.

### Data Storage

All data lives in `~/.bossmode/` — plain text and JSON, easy to back up and migrate:

```
~/.bossmode/
├── config.json              # Global settings (credentials, port, runtime config)
├── bossmode.pid             # Daemon process PID
├── bossmode.log             # Server log
├── members.json             # Member configurations (runtime + model assignments)
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

Runtime detection happens automatically. `bossmode status` shows which runtimes are available and their detected versions.

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
