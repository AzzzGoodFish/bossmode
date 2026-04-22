# Changelog

All notable changes to Bossmode are documented here.

---

## [0.8.7] — 2026-04-22

### Refactor
- **Unified member state machine transitions** — centralized agent status transitions (`inactive`/`idle`/`working`) through `agent-manager.transition()`, removing scattered state writes and reducing runtime status drift risk.
- **Runtime prompt flow templated in base class** — consolidated shared work lifecycle primitives (`startWork`, `sendCommand`, `endWork`, `failWork`) in `BaseCliAgentHandle`, reducing duplication across `pi-cli` and `claude-cli` runtimes.

### Fixed
- **Compact timeout false-failure eliminated** — `pi-cli` compact now runs as fire-and-forget command flow and completes via async response handling, removing the previous 30s RPC-timeout mismatch that could report failure despite successful compaction.

### Added
- **Summarizer timeout protection** — added 5-minute per-batch idle timeout guard in summarization flow to prevent stuck runs from hanging indefinitely.

### Tests
- Added/updated unit coverage for base runtime work lifecycle helpers and `pi-cli` compact fire-and-forget async completion path.
- **Release note**: `refactor: unified member state machine; fix: compact fire-and-forget eliminates timeout; feat: summarizer 5min timeout protection`.

## [0.8.6] — 2026-04-22

### Fixed
- **RuleDocs reference cascading on knowledge changes** — moving a knowledge doc now automatically rewrites matching `room.ruleDocs` paths, and deleting a knowledge doc now removes stale `room.ruleDocs` references.
- **Room Settings phantom-rule selection mismatch** — Room Settings now filters out non-existent rule paths when loading selection state, so selected counts and checkboxes only reflect valid documents.

### API
- **Knowledge move/delete now coordinate room bindings** — `POST /api/knowledge/move` and `DELETE /api/knowledge/entry` now trigger room-level `ruleDocs` reference reconciliation.

### Tests
- Added acceptance coverage for room `ruleDocs` cascade behavior after knowledge move and delete operations.
- **Release note**: `fix: cascade room ruleDocs refs on knowledge move/delete; filter phantom paths in settings UI`.

## [0.8.5] — 2026-04-22

### Added
- **Room Settings panel** — new Room menu entry (`Settings`) opens a unified dialog for room-level configuration.

### Changed
- **Room configuration editing unified** — room name, working directory (`cwd`), and rule document bindings can now be edited in one save flow from the Room Settings dialog.
- **Shared rules tree component** — extracted reusable `RulesTree` and reused it across Create Room and Room Settings dialogs.
- **Room menu theme parity** — RoomMenu now supports consistent light/dark theme styling.

### API
- **Room PATCH supports cwd updates** — `PATCH /api/rooms/:id` now accepts `cwd` along with `name` and `ruleDocs`.
- **Client API unified patch helper** — added `updateRoomSettings(id, { name?, cwd?, ruleDocs? })`.

### Validation & UX
- **cwd existence validation** — backend rejects non-existent directories with `400 Directory does not exist`.
- **cwd change warning** — UI warns that running agents must be restarted for new working directory to take effect.
- **Save-state guards** — save disabled when no effective changes or invalid name.

### Tests
- Added acceptance coverage for room settings PATCH updates (`name/cwd/ruleDocs`) and invalid-cwd rejection.
- **Release note**: `feat: Room Settings panel (rule docs selector, name & cwd editing)`.

## [0.8.4] — 2026-04-22

### Changed
- **Runtime handle internals refactored** — extracted `BaseCliAgentHandle` to consolidate shared lifecycle/state/request logic across `pi-cli` and `claude-cli` runtimes, eliminating duplicated implementation patterns while preserving runtime-specific protocol behavior.

### Refactor
- **Extracted base class for runtime common logic** — `refactor: extract BaseCliAgentHandle to eliminate runtime code duplication`.

## [0.8.3] — 2026-04-21

### Changed
- **Collapsible sidebar now uses icon-only compact mode** — sidebar collapse behavior changed from full hide to a persistent narrow icon rail (`w-12`), with section icon navigation, unread aggregation dot on Rooms, header in-rail expand control, and preserved width-transition animation.

### Fixed
- **Pi CLI activity-timeout state desync** — 90s no-stdout timer is now warning-only (no forced `_isWorking=false`, no synthetic `agent_end`, no prompt rejection), preventing false timeout/"already processing" split-brain between room status and runtime activity.
- **Claude CLI activity-timeout state desync** — aligned with Pi CLI: 90s no-stdout is warning-only (no forced state reset / synthetic `agent_end` / prompt rejection), so long-running summarize jobs no longer fail from false inactivity timeout.
- **Summarizer large-input reliability** — added automatic batching for large rooms (`>100` messages, batch size 100) with per-batch progress messages (`Summarizing batch x/y`), improving tool-call success rate on large histories.

## [0.8.2] — 2026-04-21

### Fixed
- **pi-cli Session Resume state capture** — fixed `get_state` RPC response parsing in `src/engine/runtime/pi-cli.ts` (`raw.state` → `raw.data`), so `onSessionChanged` now receives `sessionId`/`sessionFile` correctly and subsequent restarts can resume with `--session <file>`.
- **Resume-off cursor inconsistency on restart** — when `runtime.sessionResume=false`, server startup now resets all persisted agent cursors to `null`, ensuring fresh sessions receive recent room context instead of an empty incremental window.
- **Markdown light-theme contrast issues** — updated Markdown renderer styles (`web/src/components/Markdown.tsx`) for dual-theme compatibility (`dark:` variants) across inline code, links, blockquotes, tables, `<hr>`, and `<del>` text.
- **Markdown long-line overflow in unfenced-language code blocks** — added explicit `pre` renderer styles (`overflow-x-auto` + dual-theme background + spacing) so long lines no longer overflow message bubbles.
- **Restart endpoint session wipe + delayed respawn** — fixed `POST /api/members/:id/restart` (`src/api/workforce.ts`) to preserve existing `sessionId`/`sessionFile` (removed runtime-only `saveSession` overwrite) and trigger immediate background re-activation (`activateAgent`) instead of waiting for next `@mention`.
- **Regression coverage for get_state mapping** — added unit test to assert `{ command: "get_state", success: true, data: { ... } }` triggers `onSessionChanged` with the expected session payload; added startup test coverage for cursor reset when session resume is disabled.

## [0.8.1] — 2026-04-21

### Changed
- **Message envelope delivery for agent inputs** — incoming trigger messages are now wrapped with explicit source metadata (room/private + sender) and a single footer that tells the agent how to reply (`target="room"` or `target="user"`). Batch deliveries now wrap per-message, while `summary` messages remain pass-through.
- **Layer 5 environment prompt slimmed down** — removed duplicated `Available Tools` / `Communication Rules` sections from system prompt; tool-usage rules now live with tool descriptions.
- **Chat tool descriptions strengthened (MCP + pi-cli parity)** — `chat` now documents envelope-authoritative target routing, mentions semantics, and rewrite behavior consistently across runtimes.

### Fixed
- **Room-activated agents replying privately** — server now enforces target safety: when activation source is room mention and agent calls `chat(target="user")`, backend rewrites to `target="room"`, posts publicly, and returns a warning.
- **Activation-source tracking for routing safety** — added per-agent latest activation source context (`room_mention` / `private_instruction` / `system` / `self_start`) with stale-read TTL and lifecycle cleanup, enabling deterministic target enforcement.
- **Chat tool description drift** — unified pi-cli and MCP runtime descriptions through a shared `buildChatToolDescription()` source of truth (`src/shared/chat-tool-description.ts`), eliminating wording skew between runtimes.
- **User display name consistency in envelopes** — both room and private envelopes now render the user as `@fish` via a shared `USER_DISPLAY_NAME` constant (`src/shared/user-identity.ts`), eliminating the prior drift where private envelopes hardcoded `"fish"` while room envelopes showed the raw internal sender id `"user"`.

## [0.8.0] — 2026-04-20

### Changed (breaking: knowledge namespace & room binding)
- **Knowledge Base concept removed.** All documents now live in a single global tree at `~/.bossmode/knowledge/docs/`. The per-project KB container has been dissolved — users organize projects using top-level folders (e.g. `docs/bossmode/…`, `docs/freeu/…`), the same way Notion/Obsidian/Feishu work. This eliminates a redundant layer of indirection without losing any organizational power.
- **Rooms no longer bind to a Knowledge Base.** The `room.knowledgeBaseId` field is gone; rooms only keep `ruleDocs: string[]` (paths relative to the shared root) to control which documents are injected as rules. Every agent in every room can read/write the whole knowledge tree.
- **API routes flattened:**
  - `GET    /api/knowledge/tree` — single global tree
  - `GET    /api/knowledge/entries` — flat list of all docs
  - `POST   /api/knowledge/entries` — create doc at path
  - `GET    /api/knowledge/entry?path=…` — read
  - `PUT    /api/knowledge/entry?path=…` — update
  - `DELETE /api/knowledge/entry?path=…` — delete
  - `POST   /api/knowledge/move` — rename/move
  - **Removed:** `GET/POST/DELETE /api/knowledge`, `GET /api/knowledge/:id`, and all `/api/knowledge/:id/*` nested routes.
- **Agent tools no longer take a KB context.** `save_knowledge` / `update_knowledge` / `delete_knowledge` / `query_knowledge` / `read_knowledge` now operate on the single global tree; they work in every room regardless of binding.
- **Sidebar simplified.** The Knowledge section used to expand into a list of KBs; it is now a single button that jumps directly to the Knowledge page.
- **Knowledge page redesigned as two-pane.** Left: collapsible, resizable file tree (folders default-collapsed; width persisted to `localStorage`). Right: Markdown viewer/editor. Drag the divider to resize.
- **CreateRoomDialog.** The KB selector is removed. Rules are now picked from a tree-style selector over the whole knowledge tree. When you type a working directory, the dialog auto-suggests `<cwd-basename>/rules/*.md` (e.g. `bossmode/rules/*` when cwd ends in `…/bossmode`), falling back to root `rules/*`. This is a soft suggestion — users can override freely.

### Migration (automatic on first 0.8.0 startup)
- Each legacy KB directory (`~/.bossmode/knowledge/<kbId>/docs/`) is copied into `~/.bossmode/knowledge/docs/<kbNameSlug>/` (e.g. KB "Bossmode" → `docs/bossmode/`, KB "FreeU" → `docs/freeu/`). Colliding slugs are suffixed with `-2`, `-3`, etc.
- The original KB directory (including `entries.legacy/` from the 0.7.0 migration and `knowledge.json`) is renamed to `<kbId>.legacy/` for safe rollback. Nothing is deleted.
- Each room's `knowledgeBaseId` is stripped and its `ruleDocs` paths are prefixed with the old KB's slug. `ruleIds` (deprecated in 0.7.0) is dropped. Room JSON is backed up to `<roomDir>/room.json.pre-0.8.0-backup` before rewrite.
- Migration is idempotent: a second startup detects already-migrated state and skips.
- Fresh installs (no legacy KBs) automatically seed `docs/rules/dev-team-protocol.md` from the built-in template. Migrated installs are **not** re-seeded at the root — their existing project-scoped rules (e.g. `bossmode/rules/dev-team-protocol.md`) remain authoritative.

### Why
- The KB container layer was redundant once 0.7.0 moved storage onto the filesystem: folders already provide everything KBs were providing (namespacing, organization), without the extra concept to learn. Removing it simplifies the mental model: one tree, user folders for project separation, rules chosen explicitly per room.
- Users can now run shared and per-project knowledge in the same tree and let the room-level `ruleDocs` picker decide what each room's agents see as injected rules.

### Known non-goals
- No per-room scope or filtering. Every agent sees the full tree. This is intentional — separation is done via folder organization, not access control.
- No automatic pruning of `<kbId>.legacy/` directories. Delete them manually once you've verified the migration.

---

## [0.7.0] — 2026-04-20

### Changed (breaking: knowledge base storage & agent tools)
- **Knowledge base is now filesystem-native.** Each KB is a directory of Markdown files under `~/.bossmode/knowledge/<kbId>/docs/`, organized however you want (e.g. `rules/`, `architecture/`, `prds/`, `implementation-plans/`). Document IDs are paths (e.g. `architecture/overview.md`). Hierarchy is expressed by directories — no `type: "rule" | "knowledge"` field anymore. Documents can be edited with any external tool (VS Code, Obsidian, git).
- **Rules are now a room-level binding, not a content attribute.** `room.ruleDocs: string[]` lists document paths to inject as rules. Room creation dialog lets you pick any document as a rule (docs under `rules/` are selected by default).
- **Knowledge is no longer auto-injected into system prompts.** Agents get a directory-tree INDEX of available documents and read them on demand via `query_knowledge` / `read_knowledge`. This ends the silent spawn-failure risk caused by Linux `MAX_ARG_STRLEN` (128KB per argv entry) when KBs grow large, especially with Chinese / multi-byte content.
- **New agent tool: `read_knowledge(path)`** — returns a single document's full content by path.
- **Updated agent tools:**
  - `save_knowledge(title, content, path?)` — `path` replaces implicit placement; creates intermediate folders
  - `update_knowledge(path, title, content)` — `path` replaces `entryId`
  - `delete_knowledge(path)` — `path` replaces `entryId`
  - `query_knowledge()` — returns the directory tree + summary list (no content)
  - `query_knowledge(query)` — substring search across titles and bodies
- **Dev Team Collaboration Protocol is now a seed document.** Freshly created KBs auto-plant `rules/dev-team-protocol.md` from the `templates/teams/dev-team/team-prompt.md` template. It is a regular document from then on: editable, deletable, per-project.
- **New API endpoints** for file-tree operations:
  - `GET /api/knowledge/:id/tree` — directory tree for the UI
  - `GET/PUT/DELETE /api/knowledge/:id/entry?path=…` — single doc CRUD by path
  - `POST /api/knowledge/:id/move` — rename/move
  - `PATCH /api/rooms/:id` now also accepts `knowledgeBaseId` and `ruleDocs` (room creation no longer kills rule binding control)
- **Frontend KnowledgePage rewritten** as a file-tree sidebar + Markdown viewer/editor.
- **One-time migration** runs on first startup: legacy `<kbId>/entries/<uuid>.json` files are converted to categorized Markdown files (by title heuristic: PRDs, Implementation Plans, Architecture, etc.), room `ruleIds` (UUIDs) are translated to `ruleDocs` (paths), and the old `entries/` folder is preserved as `entries.legacy/` for safety.

### Fixed
- **E2BIG spawn failure with large Chinese knowledge bases** — fixing this was the direct driver of the filesystem rewrite. System prompts now scale to 1000+ documents without hitting the per-argv byte limit.

---

## [0.6.3] — 2026-04-17

### Changed
- **@ 语义纯化** — `mentions` 参数成为唯一激活权威通道，content 里的 `@name` 仅作为文本引用，不再触发激活。防止引用同事时误激活。
- **Chat 工具 orphan warning** — content 含 `@name` 但 mentions[] 未包含时，工具返回 warning 提示，引导 agent 按需 resend。
- **Summarizer 默认 model 改为 sonnet**（原 haiku）— 提升工具调用可靠性。现有 summarizer member 不受影响；新环境首次使用时 auto-create 将用 sonnet。

### Fixed
- **Summarize UI 卡在 "Summarizing..." 不消失** — summarize 成功后未 post completion 系统消息。现在成功后会显示 `Summarization complete: N messages condensed into M summaries.`
- **Summarize 第二次触发总结进度消息导致 90s timeout** — `getUnsummarizedMessages` 未过滤 sender=system。现在过滤所有系统消息。
- **Summarize 0 summaries silent failure** — 若 summarizer agent 未调用 `write_summary`，原本显示 "Summarization complete: N condensed into 0 summaries"。现在 0 summaries 会明确提示用户重试或切换模型。

### Improved
- **pi-cli runtime 补齐 write_summary 工具**（与 MCP server 对齐）— 允许 summarizer member 切换到 pi-cli runtime 使用。

## [0.6.1] — 2026-04-17

### Fixed
- **Agent chat @mention duplicate spawn** — removed redundant direct activation path in tool callbacks so mentions activate only once via `message-bus -> router`.
- **Concurrent agent create race (TD-A4)** — `getOrCreate` now deduplicates concurrent creations with a pending promise map.
- **Self-mention guard** — router now skips `@sender` self-activation.

## [0.6.0] — 2026-04-17

### Runtime 控制增强 v1

#### New Features
- **Session Resume global toggle** — Settings page now has a "Session Resume" switch. When disabled, new agent instances start fresh sessions instead of resuming prior ones. Applies to all runtimes (pi-cli and claude-cli). Existing running agents are not affected.
- **xhigh thinking level** — Members page Thinking Level dropdown now includes `xhigh` (maps to max effort), completing the full range: `off / minimal / low / medium / high / xhigh`.
- **Chat tool auto-mention** — When an agent calls the `chat` tool with `@name` in the message content but no explicit `mentions` parameter, the system automatically parses and activates the mentioned room members. Private messages (`target: "user"`) are excluded. The tool response now includes an `autoMentions` field listing resolved names. Duplicate mentions are silently deduplicated.

#### Improvements
- **Context usage push strategy** — Backend now updates context usage cache on agent idle transitions and pushes `agent:context_usage` WebSocket events. Frontend removed all polling (setInterval and working/idle triggered pulls). Room load performs one cache read; all subsequent updates are WS-driven.
- **Context usage API is cache-only** — `GET /api/rooms/:id/agents/:agent/context-usage` now returns cached values only, eliminating unnecessary CLI process communication.
- **claude-cli runtime improvements** — Environment variables corrected (`CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `DISABLE_AUTOUPDATER=1`); MCP transport switched from stdio subprocess to HTTP (eliminates MCP startup latency); session ID tracking via `--settings` hook (fixes resume after compact/fork).
- **pi-cli `--no-extensions` removed** — pi-cli now runs without the `--no-extensions` flag, enabling user extensions.

#### Bug Fixes
- Fixed chat tool `@mention` activation being ignored when `mentions` parameter was empty but content contained `@name`.

---

## [0.5.0] — 2026-04-09

### 智能消息摘要 (Smart Message Summary)

#### New Features
- **AI-powered message summarization** — Replaced the old Archive feature with intelligent topic-based summarization. The built-in `summarizer` agent reads accumulated messages and generates structured summary cards grouped by topic.
- **Summarizer as system agent** — `summarizer` is a built-in agent template with a default member configuration (claude-cli + haiku). Configurable via the Members page (runtime, model, thinking level).
- **Summary message type** — New `type: "summary"` message with metadata: title, covered range, time range, and participants. Original messages are preserved on disk.
- **Summary card UI** — Violet-accent summary cards in the chat timeline with expandable original message view. Inline async loading with caching.
- **Auto-summarization** — Settings page: enable auto-summary with configurable threshold (default 200 messages) and keep count (default 50).
- **`write_summary` tool** — Summarizer-exclusive MCP tool with caller verification. Writes structured summary messages via tool callback.
- **Agent context merge** — `getMessages` / `getMessagesSince` return merged views: summaries replace covered original messages. Agents see compact context automatically.

#### Removed
- Old Archive button and 3 archive API endpoints removed. Existing archive data preserved.

---

## [0.4.0] — 2026-04-11

### Claude Runtime 改进 v2

#### New Features
- **claude-cli runtime** — Full support for claude-cli (Claude Code) as an agent runtime alongside pi-cli.
- **MCP HTTP transport** — MCP server moved from stdio subprocess to HTTP endpoint on the main server, eliminating per-agent MCP process startup overhead.
- **Session hook tracking** — `--settings` hook mechanism tracks session ID changes (including after compact and fork), fixing session resume reliability.

#### Improvements
- Environment variables for claude-cli spawn corrected.
- pi-cli `--no-extensions` flag removed.

---

## [0.3.0] — 2026-03-29

### 架构重写 v3.0

#### Architecture
- **Five-domain restructure** — Codebase reorganized into Workforce / Workspace / Knowledge / Communication / Engine domains (31 backend files).
- **API split** — Original 824-line `api.ts` split into 7 domain-specific route files.
- **Communication decoupling** — message-bus (observer pattern) → router (callback injection) → engine. No direct coupling between layers.

#### New Features
- **React dialog system** — Unified `ConfirmDialog` / `PromptDialog` / `Toast` components. All 28 native browser dialogs replaced.
- **Knowledge tool completeness** — Added `update_knowledge` and `delete_knowledge` agent tools.
- **Token limit guard** — Tool results capped at 25,000 characters. `query_knowledge` without arguments returns an index summary instead of full content.
- **Stability fixes** — `proc.on("error")` handler, `safeStdinWrite()` protection, WebSocket dead client cleanup, `parseBody` 1MB limit.

#### Tests
- 181 Vitest tests passing.
- 57/57 Playwright E2E tests passing.

---

## [0.2.0] — 2026-03-20

### 四大模块扩展

#### New Features
- **Agent management** — Create, edit, delete agent definitions. Built-in templates: pm, architect, developer, qa, designer.
- **Skill management** — Create, edit, delete skill documents. Attach files to skills. Multi-directory skill scanning.
- **Member management** — Assign agents to runtime + model configurations. Per-member: thinking level, context limit, skill toggles. Human member type.
- **Knowledge base** — Room-level shared context. Two entry types: knowledge and rule. Rule selective injection. Agent tools: save, query.
- **Private chat / Agent Activity** — View agent internal work (tool calls, thinking). Send steer instructions. Restart agent instances.

---

## [0.1.0] — 2026-03-15

### Initial Release

#### Features
- Chat rooms with @mention agent activation and @all broadcast.
- Real-time streaming agent responses via WebSocket.
- Message history with per-agent cursors (incremental context).
- Session resume: agents restart from prior session context.
- pi-cli runtime integration.
- Light/dark theme, login/logout, basic settings.
- File-system persistence (no external database).
- 131 passing tests.
