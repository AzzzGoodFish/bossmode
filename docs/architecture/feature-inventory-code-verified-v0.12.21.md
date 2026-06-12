---
title: Feature Inventory (Code-Verified) — Bossmode v0.12.21
author: architect
status: active
---

# Feature Inventory (Code-Verified) — Bossmode v0.12.21

**Purpose**: Authoritative, code-verified map of what Bossmode actually does today, with each feature's **frontend entry point** (page/component) and **backend** (routes/modules), plus a **deprecated/not-shipped** list — input for PM's product-view list and Designer's frontend refactor.

**Method**: verified against `src/` (engine/api/workspace/...) and `web/src/` at version `0.12.21`. Supersedes the stale `功能全景与高阶抽象5-个核心域.md` (v0.8.3).

---

## 1. Navigation map (what the user can reach)

**Primary nav — `web/src/components/Sidebar.tsx`** (`ActivePage` union):
- **Rooms** (`type:"room"`) — group chat workspace
- **Members** (`type:"member"`)
- **Agents** (`type:"agent"`)
- **Skills** (`type:"skill"`)
- **Knowledge** (`type:"knowledge"`)
- **All Tasks** (`type:"all-tasks"`) + **Task detail** (`type:"task"`)
- **Settings** (`type:"settings"`)

**Room view tabs — `web/src/pages/Main.tsx`**: `Chat (room)` | `Tasks` | per-agent **Activity** tabs (opened on demand).

**Shell**: `App.tsx` → `Login.tsx` (token auth) → `Layout.tsx` (desktop sidebar + `MobileDrawer`/`MobileTopBar` responsive).

---

## 2. Feature domains (live)

### A. Rooms & Group Chat
- **What**: multi-member rooms; user + agents converse; @mention activation; message envelopes + target enforcement; private (1:1) chat; per-room cwd.
- **FE**: `ChatArea`, `MessageBubble`, `MessageInput`, `MemberPanel`, `PrivateChat`, `RoomList`, `RoomMenu`, `RoomSettingsDialog` (rule/name/cwd), `CreateRoomDialog`, `FolderPicker`.
- **BE**: `communication/{router,ws,message-bus}.ts`, `workspace/{room-store,message-store}.ts`, `engine/{message-envelope,activation-context,event-handler}.ts`; routes `/api/rooms*`, `/api/rooms/:id/messages*`.

### B. Members (runtime instances of agents in a room)
- **What**: assign agent + model + credential + thinking level; live status; lifecycle controls.
- **FE**: `MembersPage`, `ModelPicker`, `AddMemberDialog`, `model-helpers.ts` (model badge).
- **BE**: `workforce/member-store.ts`, `engine/agent-manager.ts`; routes `/api/members*` (incl. `:id/restart`, `:id/status`, `:id/token-usage`), `/api/rooms/:id/agents/:agent/{abort,steer,reset-session,context-usage,events}`.

### C. Agents (definitions / templates)
- **What**: author agent definitions (prompt, model default, skills, avatar); built-in templates.
- **FE**: `AgentsPage`, `AgentDetailPage`, `AgentList`.
- **BE**: `workforce/agent-store.ts`; routes `/api/agents*`, `/api/agents/templates`.

### D. Skills
- **What**: reusable skill docs attached to agents/members; templates.
- **FE**: `SkillsPage`, `SkillDetailPage`.
- **BE**: `workforce/skill-store.ts`; routes `/api/skills*`, `/api/skills/templates`.

### E. Knowledge (filesystem-backed docs)
- **What**: project doc library (PRDs/plans/specs/rules) as a real filesystem tree; in-app editor; move/batch ops; rule docs injected into prompts. **Agent access is via filesystem tools (read/edit/write/bash), the old knowledge tool is retired.**
- **FE**: `KnowledgePage`, `MarkdownEditor` (MDXEditor), `MarkdownField`, `Markdown`, `RulesTree`, `MoveToDialog`.
- **BE**: `knowledge/{store,migration}.ts`; routes `/api/knowledge/{tree,entries,entry,move,batch-move,batch-delete}`.

### F. Tasks (board + Linear)
- **What**: lightweight task board (todo→in-progress→review→done); comments, subscribers, references, assignee (assign does NOT auto-activate); reviewer workflow; optional Linear sync.
- **FE**: `TaskBoard`, `TaskList`, `TaskCard`, `TasksTab`, `AllTasksPage`, `TaskDetailPage`, `resource-list-filter.ts`.
- **BE**: `workspace/task-store.ts`, `integrations/{linear-client,linear-settings,task-linear-sync}.ts`; routes `/api/rooms/:id/tasks*`, `/api/tasks`, `/api/integrations/linear`.

### G. Model Credentials & Providers
- **What**: **Connect Provider** (built-in catalog, api_key or OAuth), **Custom Endpoint** (manual models, proxy/local), OAuth login jobs, fetch/discover models, **per-model customizations (Enabled + contextWindow, 0.12.21)**, model hot-switch across credential/provider (0.12.20), member model picker.
- **FE**: `SettingsPage` (Model Credentials section: `ConnectProviderSheet`, `ProfileSheet`), `ModelPicker`.
- **BE**: `engine/model-credentials.ts` (+ `runtime/pi-sdk.ts` export); routes `/api/model-credential-profiles*` (alias `/api/model-providers*`), `/api/models`, `/api/available-models`, `/api/model-provider-catalog`.

### H. Runtime control (in-process pi SDK)
- **What**: in-process pi Agent SDK runtime (`@earendil-works/pi-coding-agent`); thinking levels (off→xhigh), session resume toggle, context-usage push, model hot-switch, abort/steer/restart/reset-session, authoritative agent_start/agent_end status.
- **FE**: Settings → Runtime (`sessionResume`); Member controls; `AgentTab` (activity/thinking stream, context usage).
- **BE**: `engine/runtime/{pi-sdk,pi-events,registry,bossmode-sdk-tools,env}.ts`, `engine/agent-manager.ts`; routes `/api/capabilities`, `/api/settings/runtime`.
- **Agent tools exposed** (`bossmode-sdk-tools.ts`): `chat`, `query_room_messages`, `create_task`, `update_task`, `list_tasks`, `get_task`, `comment_task`, `query_integration`, `configure_integration`, `write_summary` (+ pi built-ins read/bash/edit/write).

### I. Summarization
- **What**: smart message summary (topic segments) + summarizer observability; summary settings.
- **FE**: `SummaryCard`; Settings → Summary.
- **BE**: `engine/summarizer.ts`; routes `/api/rooms/:id/summarize`, `/summarize/status`, `/api/settings/summary`.

### J. Message search & retrieval
- **FE**: `MessageSearchBar`, `streaming-delta.ts`.
- **BE**: routes `/api/rooms/:id/messages/search`, `/messages/range`.

### K. Attachments
- **What**: streaming upload with progress/cancel; attachment rows with image lightbox / file download in chat.
- **FE**: `AttachmentUploader`, `MessageBubble` (attachment preview/lightbox).
- **BE**: `workspace/attachment-store.ts`, `engine/agent-attachments.ts`, `api/uploads.ts`; routes `/api/rooms/:id/upload`, `/api/rooms/:id/attachments/:filename`.

### L. Integrations — Linear
- **What**: connect Linear (team/project bind), task push/sync, status.
- **FE**: `SettingsPage` (Linear section).
- **BE**: `integrations/*`, `api/integrations.ts`; routes `/api/integrations/linear`.

### M. Built-in Team Versioning / Team Updates
- **What**: ship built-in agents/skills/rules as versioned team; check/apply/dismiss updates.
- **FE**: `SettingsPage` (Team Updates section).
- **BE**: `workforce/team-updates.ts`, `api/team-updates.ts`; routes `/api/team-updates/{check,settings,apply,dismiss}`.

### N. Token usage tracking
- **BE**: `workspace/token-usage-store.ts`; route `/api/members/:id/token-usage`. FE: Members page badge.

### O. Mobile responsive
- **FE**: `MobileDrawer`, `MobileTopBar`, responsive `Layout`/`Sidebar`.

### P. Auth
- **FE**: `Login.tsx`, `api/client.ts` (token). **BE**: `api/auth.ts`; route `/api/auth/login`.

---

## 3. Deprecated / removed / NOT shipped — do NOT design for these

- **boss-api Model Gateway** (admin product UI, `/v1/model-stream`, capability model, gateway hardening) — **discontinued line**; lives only in `docs/bossmode/archived/`. No code in `src/`. Superseded by native Model Credentials (domain G).
- **pi CLI runtime** (`engine/runtime/pi-cli.ts`, `base-cli-handle.ts`) — **dead code**; no importers. Only `PiSdkRuntime` is registered (`server/index.ts`). The name "pi-cli" survives only as a storage key. (Tech-debt: remove.)
- **Knowledge agent tool** — retired; agents now use filesystem tools directly. No `read_knowledge`/`write_knowledge` in agent tools.
- **Chat Artifacts Instant Preview v1** — full doc set exists (`prd-/implementation-plan-/design-spec-/test-plan-chat-artifacts`), but **no implementing code found** in `web/src` (the only "preview" in chat is attachment image lightbox). **Treat as specced-but-not-shipped — confirm with PM before counting it as a feature.**

---

## 4. Notes for the frontend refactor

- The app is a **single-shell, state-driven SPA** (no router lib): `Layout` switches on `ActivePage`; room view manages its own tab strip in `Main`. Any nav/IA redesign centers on `Sidebar` + `Layout` + `Main` tab model.
- Settings is one long page (`SettingsPage.tsx`) hosting Model Credentials + Runtime + Summary + Linear + Team Updates — a prime candidate for IA restructuring.
- Model Credentials editor recently unified (0.12.21) to Custom-Endpoint-style vertical cards; keep that as the pattern reference.
