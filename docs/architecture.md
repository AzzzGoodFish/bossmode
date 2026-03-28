# Bossmode Architecture

**Author**: Architect
**Status**: Approved
**Date**: 2026-03-19

## 1. System Architecture

```
┌─ CLI ──────────────────────────────────────────────┐
│ bossmode on [--host --port] / off / status         │
└──────────┬─────────────────────────────────────────┘
           │ fork daemon
┌─ Server (daemon process) ──────────────────────────┐
│                                                     │
│  ┌─ Web Layer ─────────────────────────────────┐   │
│  │ HTTP: static files (frontend) + REST API    │   │
│  │ WebSocket: real-time push (messages, state) │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─ Message Router ────────────────────────────┐   │
│  │ Parse @ mentions → resolve target agents    │   │
│  │ Route agent chat tool calls → room          │   │
│  │ Route private messages → agent.steer()      │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─ Agent Manager ─────────────────────────────┐   │
│  │ pi-mono agent instances (per room×agent)    │   │
│  │ Lifecycle: create / prompt / steer / idle   │   │
│  │ Event forwarding → WebSocket                │   │
│  │ Custom tools: chat, mention                 │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─ Room Manager ──────────────────────────────┐   │
│  │ Room CRUD, member management                │   │
│  │ Message storage, per-agent cursors          │   │
│  └─────────────────────────────────────────────┘   │
│                                                     │
│  ┌─ Store ─────────────────────────────────────┐   │
│  │ JSON file persistence (no external DB)      │   │
│  │ ~/.bossmode/rooms/<id>/                     │   │
│  │ ~/.bossmode/config.json                     │   │
│  │ ~/.bossmode/agents/*.md                     │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

Dependency direction: Web Layer → Message Router → Agent Manager / Room Manager → Store

## 2. Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Language | TypeScript | Matches pi-mono ecosystem, type safety |
| Server | Node.js + native http | NF1: minimal deps |
| WebSocket | ws | Lightweight, well-maintained |
| Frontend | React + Vite | Component model fits chat UI; Vite for fast dev |
| Styling | Tailwind CSS | Utility-first, rapid UI dev |
| Persistence | JSON files | NF4: no external DB |
| Agent runtime | pi-mono (library) | Core requirement |

Alternative considered: Fastify/Express for server. Rejected: native http is sufficient for our API surface, avoids unnecessary deps.

Frontend serving: Vite dev server during development (with proxy to backend API). In production, `vite build` outputs static files to `web/dist/`, served directly by the daemon's HTTP server.

## 3. Pi-Mono Integration

### Agent Instance Model

Each agent instance is scoped to a **(agent, room)** pair:
- Same agent definition (e.g., "architect") in different rooms = different instances with different cwd
- Instances are **lazy-created**: first @ mention in a room triggers creation
- Instances **persist in memory** for the daemon's lifetime (room context survives across interactions)

### Graceful Shutdown

On `bossmode off`, AgentManager.shutdownAll():
1. For each active instance: if idle, destroy immediately; if working, send abort signal and wait (5s timeout)
2. After timeout, force terminate remaining instances
3. All agent event subscriptions cleaned up, WebSocket connections closed

### Instance Creation

```
User @pm in room →
  AgentManager.getOrCreate(roomId, "pm") →
    1. Load agent definition from ~/.bossmode/agents/pm.md
    2. Build system prompt (agent def + team prompt)
    3. Create pi-mono agent:
       createAgentSession({
         cwd: room.cwd,
         tools: [...codingTools(room.cwd), chatTool, mentionTool],
         model: agentDef.model,
         systemPrompt: combinedPrompt,
       })
    4. Subscribe to agent events → forward to WebSocket
    5. Store instance in memory map: (roomId, agentName) → AgentInstance
```

### Custom Tools

Two tools registered on every agent instance:

**chat** — Post message to the room
```
name: "chat"
params: { message: string }
execute: (id, {message}) => {
  roomManager.addMessage(roomId, { sender: agentName, content: message });
  broadcast via WebSocket to all room subscribers;
  return { content: [{ type: "text", text: "Message sent to room" }] };
}
```

**mention** — @ another agent in the room
```
name: "mention"
params: { agent: string, message: string }
execute: (id, {agent, message}) => {
  // Post to room as "[agentName]: @agent message"
  roomManager.addMessage(roomId, { sender: agentName, content: message, mentions: [agent] });
  // Trigger activation of target agent
  messageRouter.activateAgent(roomId, agent);
  return { content: [{ type: "text", text: `@${agent} notified` }] };
}
```

### Activation Flow

```
@pm detected (user or agent) →
  AgentManager.activate(roomId, "pm") →
    1. Get or create pm's agent instance
    2. Compute incremental messages:
       messages = roomManager.getMessagesSince(roomId, pm.lastSeenCursor)
    3. Update pm.lastSeenCursor to latest message
    4. If pm is idle:
       agent.prompt(formatAsUserMessage(messages))
    5. If pm is working:
       agent.steer(formatAsUserMessage(messages))
    6. Set pm status → "working"
    7. Broadcast status change via WebSocket
    8. On agent completion:
       Set pm status → "idle"
       Broadcast status change
```

### Event Streaming (Private Chat)

```
agent.subscribe((event) => {
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      → WebSocket push to subscribers of this agent's private channel
  }
})
```

## 4. Data Model

### Config (`~/.bossmode/config.json`)
```json
{
  "auth": { "username": "fish", "passwordHash": "bcrypt..." },
  "apiKeys": { "anthropic": "sk-...", "openai": "sk-..." },
  "defaults": { "host": "127.0.0.1", "port": 8080 }
}
```

### Room (`~/.bossmode/rooms/<roomId>/room.json`)
```json
{
  "id": "uuid",
  "name": "openteam dev",
  "cwd": "/home/fish/dev/llm/opencode-dev/openteam",
  "members": ["pm", "architect", "developer", "qa"],
  "createdAt": 1710000000000
}
```

### Messages (`~/.bossmode/rooms/<roomId>/messages.jsonl`)
```jsonl
{"id":"msg-1","sender":"user","content":"@pm analyze the README","mentions":["pm"],"ts":1710000001000}
{"id":"msg-2","sender":"pm","content":"I've analyzed the README. Here are the key findings...","mentions":[],"ts":1710000030000}
{"id":"msg-3","sender":"pm","content":"@architect please design the implementation plan","mentions":["architect"],"ts":1710000035000}
```

JSONL format: append-only, one message per line, efficient for streaming reads.

### Agent Cursors (`~/.bossmode/rooms/<roomId>/cursors.json`)
```json
{
  "pm": "msg-3",
  "architect": "msg-1",
  "developer": null,
  "qa": null
}
```

When a new member is added (F16), their cursor is initialized to the latest message ID at join time — they see messages from join onward, not full history.

### Archive (`~/.bossmode/rooms/<roomId>/archives/`)
```
<timestamp>.jsonl  — archived original messages
<timestamp>.summary.json — { summary: "...", archivedCount: N, range: [firstId, lastId] }
```

### Agent Definition (`~/.bossmode/agents/pm.md`)
```markdown
---
name: pm
model: claude-sonnet-4-6
description: Product Manager
---

# PM Agent
...system prompt content...
```

### PID File (`~/.bossmode/bossmode.pid`)

## 5. API Design

### REST API

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Login, returns session token |
| GET | /api/agents | List agents (from definitions) |
| GET | /api/rooms | List rooms |
| POST | /api/rooms | Create room (cwd + members) |
| GET | /api/rooms/:id | Room details |
| GET | /api/rooms/:id/messages | Get messages (with pagination) |
| POST | /api/rooms/:id/messages | Send message (parses @ mentions) |
| POST | /api/rooms/:id/members | Add member |
| POST | /api/rooms/:id/archive | Trigger archive |
| GET | /api/rooms/:id/archives | List archives |

### WebSocket Events (server → client)

```typescript
// Room messages
{ type: "room:message", roomId, message: Message }

// Agent status changes
{ type: "agent:status", roomId, agent, status: "idle" | "working" }

// Agent events (private chat subscribers)
{ type: "agent:event", roomId, agent, event: AgentEvent }
```

### WebSocket Commands (client → server)

```typescript
// Subscribe to room updates
{ type: "subscribe:room", roomId }

// Subscribe to agent private events
{ type: "subscribe:agent", roomId, agent }
```

## 6. Project Structure

```
bossmode/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli/                    # CLI entry (bossmode on/off/status)
│   │   └── index.ts
│   ├── server/                 # Daemon process
│   │   ├── index.ts            # HTTP + WebSocket server
│   │   ├── auth.ts             # Session auth
│   │   ├── api.ts              # REST API routes
│   │   └── ws.ts               # WebSocket handler
│   ├── core/                   # Business logic
│   │   ├── agent-manager.ts    # Pi-mono agent lifecycle
│   │   ├── room-manager.ts     # Room CRUD + messages
│   │   ├── message-router.ts   # @ routing, activation
│   │   └── tools.ts            # chat + mention tool factories
│   ├── store/                  # Persistence
│   │   ├── config.ts           # Config read/write
│   │   ├── room-store.ts       # Room + message files
│   │   └── agent-defs.ts       # Agent definition loader
│   └── shared/                 # Shared types
│       └── types.ts
├── web/                        # Frontend (Vite + React)
│   ├── index.html
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   │   ├── Login.tsx
│   │   │   └── Main.tsx
│   │   ├── components/
│   │   │   ├── RoomList.tsx
│   │   │   ├── ChatArea.tsx
│   │   │   ├── MemberPanel.tsx
│   │   │   ├── MessageInput.tsx
│   │   │   ├── PrivateChat.tsx
│   │   │   └── AgentList.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   └── useRoom.ts
│   │   └── api/
│   │       └── client.ts
│   ├── tailwind.config.js
│   └── vite.config.ts
└── docs/
    ├── prd-bossmode.md
    └── architecture.md
```

## 7. Implementation Phases

### Phase 1: Foundation (F1, F2, F21)
- Project scaffolding: TypeScript, build config, monorepo layout
- CLI: `bossmode on` (fork daemon, PID file), `bossmode off`, `bossmode status`
- HTTP server: serve static frontend + API skeleton
- Auth: login endpoint, session token, middleware
- Config store: `~/.bossmode/config.json`, first-run setup
- API key management: env var → config fallback
- Frontend: login page only

### Phase 2: Rooms & Messages (F3, F4, F5, F9, F17)
- Agent definition loader (`~/.bossmode/agents/*.md`)
- Room manager: create, list, persist
- Message store: JSONL append, read with pagination
- WebSocket infrastructure: subscribe/broadcast
- Frontend: main layout, room list, chat area, member panel, message input

### Phase 3: Agent Core (F6, F7, F8, F12, F19, F20)
- Agent manager: pi-mono integration, lazy instance creation
- Custom tools: chat, mention
- @ mention parsing + activation flow
- Incremental message delivery (cursor tracking)
- @all broadcast
- Agent event subscription → WebSocket push
- Error handling: catch agent errors, post to room, reset to idle
- Frontend: agent status indicators, real-time message updates

### Phase 4: Private Chat (F10, F11, F13)
- Agent event streaming to private chat subscribers
- Private message → steer injection
- In-flight agent message injection
- Frontend: private chat window, event stream display

### Phase 5: Polish — P1 Features (F14, F15, F16, F18)
- Archive: LLM summary, original storage, summary replacement
- History query: archive browsing
- Dynamic member management
- Agent definition management (minimal UI)

## 8. Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Agent instance scope | Per (room, agent) | Same agent in different rooms = different projects, different context |
| Instance creation | Lazy (on first @) | Don't waste resources for agents that haven't been activated |
| Message format | JSONL | Append-only, efficient streaming reads, no DB needed |
| Frontend framework | React | Component model fits chat UI, large ecosystem |
| Server framework | Native http | Minimal deps per NF1, API surface is small |
| Agent persistence | pi-mono SessionManager | Agent private history managed by pi-mono; room messages managed by us |
| Real-time | WebSocket | NF3: real-time push for messages and status |

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| pi-mono API changes | Integration breaks | Pin version, integration tests |
| Large message history fills context | Agent quality degrades | Cursor-based incremental delivery; archive mechanism (F14) |
| Multiple agents active simultaneously | Memory/CPU pressure | Lazy creation, per-room scope limits active instances |
| JSONL files grow large | Slow reads | Pagination in API; archive to separate files |
| WebSocket connection drops | Missed messages | Client reconnect + fetch missed messages via REST |
