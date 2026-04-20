# Changelog

All notable changes to Bossmode are documented here.

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
