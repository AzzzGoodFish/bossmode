# Changelog

All notable changes to Bossmode are documented here.

---

## [Unreleased]

### Changed
- Station tool lifecycle action line now uses the tool name as the primary label; running/completed/error states are expressed by dot, border, color, and compact error tag instead of `RUNNING`/`DONE` main labels.
- Station, WorkstationDetail, and AgentDetail room rows now use room-scoped effective member config for model and thinking settings.
- Station and AgentDetail now expose model and thinking effort as separate compact room-scoped chips/dropdowns, including `default` to clear the room thinking override.
- Station cards now use avatar rings instead of status text tags and show `model · think <level>` inline so model names keep readable width.
- Think level text now uses a compact color scale across Station, AgentDetail, WorkstationDetail, and ThinkingPop (`default/off` gray through `xhigh` gradient).
- Station tool-end rows now retain the original tool target/command for done/error states instead of replacing content with status text or object output.
- Station stop/abort button is now absolutely positioned so it no longer compresses the inline `model · think` row.
- Model credential Settings now refresh active agent runtime credential snapshots after profile changes: idle agents refresh immediately, working agents refresh after `agent_end`, and unavailable profiles fail closed.
- Connect Provider now supports multiple credential profiles for the same provider instead of overwriting the existing connection; model pickers distinguish profiles by name/provider/API URL.
- Station error tool events now use only the status dot, border, and background for error state; the redundant uppercase `ERROR` pill was removed from event rows.

### Fixed
- Changing an agent/member model in one room no longer mutates the global member config or hot-switches the same member in other rooms.

### Added
- Room-scoped member overrides for model, credential, and thinking level, plus room member API endpoints.
- Thinking effort selector in the existing Station/AgentDetail model popover.

### Tests
- `npm test -- tests/unit/agent-event-utils.test.ts`
- `npm test -- tests/unit/room-member-overrides.test.ts tests/unit/agent-manager-model-switch.test.ts tests/unit/member-runtime-normalization.test.ts`
- `npm test -- tests/unit/agent-event-utils.test.ts tests/unit/room-member-overrides.test.ts`
- `npm run build`

---

## [0.13.12] — 2026-06-16

### Changed
- Station agent action line now displays tool lifecycle states (`RUNNING`, `DONE`, `ERROR`) and keeps the last displayable station event through streaming noise.

### Fixed
- Station action line no longer falls back to `IDLE` while an agent is still working between tool events; working with no displayable event now shows `WORKING / Waiting for activity`.

### Tests
- `npm test -- tests/unit/agent-event-utils.test.ts`
- `npm run build`
- `npx vitest run --maxWorkers=1 --minWorkers=1` (596 passed)
- Clean global install from packed tarball.

---

## [0.13.11] — 2026-06-16

### Changed
- Built-in `general` agent now uses a Bossmode-maintained practical coding assistant prompt instead of an empty body that falls through to the pi SDK default prompt. Existing installs can apply it via Built-in team update.

### Tests
- `npm test -- tests/general-agent.test.ts tests/unit/team-updates.test.ts`
- `npm run build`
- `npm test` (595 passed)
- Clean global install from packed tarball.

---

## [0.13.10] — 2026-06-15

### Fixed
- Station agent avatar mouse clicks no longer leave a misleading accent focus ring; keyboard `focus-visible` accessibility ring remains intact.

### Tests
- `npm run build`
- `npm test` (594 passed)
- Clean global install from packed tarball.

---

## [0.13.9] — 2026-06-15

### Changed
- Applied the approved comfort dark theme tokens: graphite surfaces, softer accent/status colors, more readable meta/path/placeholder text, and unchanged light theme semantics.

### Removed
- Removed the legacy pi CLI runtime shell and unauthenticated `/internal/tool-callback` HTTP transport. Pi SDK runtime tools continue to use the in-process dispatcher.

### Security
- `/internal/*` paths no longer bypass API authentication; the deleted legacy callback now returns unauthorized without a bearer token and 404 with one.

### Tests
- `npx tsc --noEmit`
- `npm run build`
- `npm test` (594 passed)
- Clean global install from packed tarball.

---

## [0.13.4] — 2026-06-13

### Fixed
- Editing a model credential and hot-switching to a model on the same provider/profile now reloads `auth.json`, so a rotated API key takes effect immediately instead of failing requests with the stale key.
- Restarting an agent whose last assistant turn ended with a provider error now preserves the prior conversation: the failed turn is rolled back (`branch`/`resetLeaf`) and the session is resumed, instead of discarding all context and starting fresh.

### Removed
- Claude Code fingerprint request profiles (`anthropic_claude_code_oauth`, `anthropic_proxy_claude_code`) and the generated proxy extension. Legacy stored profiles are normalized to `standard` on read.

### Tests
- `npx tsc --noEmit`
- `npm run build`
- `npm test` (608 passed)

---

## [0.12.21] — 2026-06-10

### Added
- Connect Provider model rows now support per-credential `Enabled` toggles and `contextWindow` overrides while keeping Custom Endpoint editing unchanged.

### Fixed
- Connect Provider model enablement and context window edits now persist across save, settings reload, catalog refresh, member model picker listing, and runtime export.

### Tests
- `npx tsc --noEmit`
- `npm run build`
- `npm test`
- Clean global install from packed tarball.

## [0.12.3] — 2026-05-28

### Changed
- Limited skill scanning to `~/.bossmode/skills`, removing legacy `~/.agents/skills` and `~/.pi/agent/skills` from the Skills UI.
- Simplified member activation: chat room messages now activate members via exact textual `@name`; the chat tool no longer exposes `mentions`.
- Task assignee changes no longer activate members; task assignment is metadata only.

### Added
- Member detail page now shows historical total tokens for that member, aggregated from room agent event usage logs.
- Added `GET /api/members/:id/token-usage`.

### Tests
- `npm run build`
- `npm test`
- `npm pack --dry-run`

## [0.12.2] — 2026-05-28

### Fixed
- Fixed Update All to apply every built-in team update candidate, including modified built-in files, after one confirmation.
- Prevented empty or partial update applies from advancing `team-meta.installedVersion` and creating same-version update prompts.
- De-duplicated rule update candidates when multiple built-in team templates map to the same live rule path.
- Added `Classify Before Acting` to built-in universal principles so members choose between answering, discussing, planning, executing, and verifying before acting.
- Reframed built-in task management rules around formal scoped work items, current status, and task descriptions as the work record.

### Tests
- `npm run build`
- `npm test`
- `npm pack --dry-run`

## [0.12.1] — 2026-05-28

### Fixed
- Fixed built-in team update to recognize legacy built-in agents/rules tracked in `team-meta.json` even when older files lack `source: builtin`.
- Fixed skill updates to treat `skills/<name>/` as a directory asset, including nested reference files, with directory-level hashing and whole-directory replacement.
- Removed deleted built-in skill directories during update while preserving custom skills.

### Tests
- `npm run build`
- `npm test`
- `npm pack --dry-run`

## [0.12.0] — 2026-05-27

### Changed
- Slimmed built-in PM, Architect, Developer, Designer, and QA prompts to reduce over-eager process, premature task creation, and proactive skill use.
- Slimmed always-injected team rules for SSOT, team protocol, and universal principles.
- Removed non-designer built-in skills and replaced legacy designer skills with the upstream `impeccable` skill.

### Tests
- `npm run build`
- `npm test`
- `npm pack --dry-run`

## [0.11.3] — 2026-05-14

### Fixed
- Fixed member model configuration initialization when `getConfiguredModels()` is still loading: stale `model + credentialId` pairs are now treated as manual overrides, avoiding accidental `Saved credential` mode selection.
- Prevented manual `provider/model` overrides from being misclassified as saved credentials when configured model list is empty or stale.
- Member model badges now validate against current configured models; unmatched credential pairs now display as `Manual model`.

### Tests
- `npm run build`
- `npx vitest run tests/unit/manual-model-helper.test.ts`

## [0.11.2] — 2026-05-14

### Fixed
- Member edit page no longer shows `Use agent default` when an explicit manual model override exists (e.g., `provider/model`) outside configured credential profile dropdown options.

## [0.11.1] — 2026-05-14

### Fixed
- Credential-backed model metadata no longer accepts stale/incorrect fallback values; profile-scoped credential + model pair now drives discovery/export behavior.
- Manual model input now respects selected credential profile provider boundaries: supports bare model IDs with selected profile, blocks mismatched provider prefixes, and requires `provider/model` when no profile is selected.
- Anthropic message protocol endpoints normalize `.../v1` to avoid duplicated base paths during runtime call assembly.
- Discovery logic is protocol-specific and no longer blocks Anthropic-compatible providers from model discovery.
- Pi catalog metadata is only applied when provider-metadata is consistent to avoid cross-provider misattribution.
- Member restart is now a silent reset (destroy instance + cursor advance) that does not trigger immediate re-activation.
- Auto compact now produces visible `agent_start` / `agent_end` lifecycle events.
- Provider/runtime errors now emit explicit room-visible messages from `message_end` summaries.
- Custom provider export and model credential clearing semantics were validated and normalized.

### Tests
- Hotfix targeted validation: `manual-model-helper`, `workforce-restart`, `pi-cli-args`, `model-credentials`, `model-credential-routes`.
- `npm run build`.

## [0.11.0] — 2026-05-13

### Breaking
- Removed Claude Code CLI runtime support and related MCP/session-hook server paths. Bossmode now uses `pi-cli` internally.
- Removed runtime selection from the user-facing member/create-room flows; model credentials are now the configuration surface.

### Added
- Model Credential Profiles with API key, no-auth/proxy, OpenAI-compatible, Anthropic Messages, and OAuth-backed provider profiles.
- Credential-backed model catalog and Member/CreateRoom model pickers with per-member `modelRef + credentialId` selection.
- Fetch Models discovery for OpenAI-compatible endpoints with best-effort metadata handling.
- OAuth credential login job flow through the pi-ai provider boundary, with token redaction in API/UI.
- Agent-scoped pi config export (`models.json`/`auth.json`) for credential-backed runtime execution.
- pi RPC `agent_start`/`agent_end` as the authoritative public working/idle status source.

### Changed
- Model metadata trust strategy is now `endpoint/provider response > pi catalog exact match > unknown in UI / internal fallback only`.
- Fetch Models no longer exposes fake default `128k` context when an endpoint only returns model IDs.
- Removed user-visible `text/images`, context, max tokens, and reasoning configuration from normal model rows; internal pi-compatible defaults are preserved for export.
- pi builtin/general agents now preserve pi's default prompt: only agent role prompts use `--system-prompt`; Bossmode env/docs/rules use `--append-system-prompt`.

### Fixed
- “Use agent default” no longer persists a concrete fallback model override.
- Member sidebar no longer exposes runtime labels or `undefined` model text.
- Prompt dispatch no longer uses optimistic public working/idle status outside runtime lifecycle events.

### Tests
- Build, unit/integration suite, real-browser E2E, and real credential smoke passed during the 0.11.0 acceptance cycle.
- Prompt args targeted verification: `npm run build` ✅; `npm test -- tests/general-agent.test.ts tests/unit/pi-cli-args.test.ts` ✅.

## [0.10.28] — 2026-04-29

### Fixed
- **MDXEditor content flush with page** — removed focus ring and reset internal wrapper padding/margin/border. Content now sits directly on page background with zero chrome.

## [0.10.27] — 2026-04-29

### Changed
- **MDXEditor toolbar removed** — Linear-style minimal editing. All formatting via markdown shortcuts (`# ` H1, `- ` list, ` ``` ` code, `Cmd+B` bold, etc.) and keyboard shortcuts. No floating toolbar chrome. Source toggle also removed for consistency.

## [0.10.26] — 2026-04-29

### Added
- **Knowledge editor WYSIWYG** — KnowledgePage edit mode now uses the same `<MarkdownEditor>` component as Task detail. Replaces raw textarea with inline rich-text editing, floating toolbar, code block support, and Source toggle. Zero additional bundle cost (MDXEditor chunk already loaded).

## [0.10.25] — 2026-04-29

### Fixed
- **MDXEditor: fenced code blocks with language tags** — added `codeMirrorPlugin` with language mappings (js/ts/python/bash/json/yaml/css/html/sql/md). Without it, ` ```js ` blocks caused parse errors. Bundle increase ~150KB (lazy loaded, only on Task detail page).

## [0.10.24] — 2026-04-29

### Fixed
- **MDXEditor: code block plugin missing** — added `codeBlockPlugin` + `InsertCodeBlock` toolbar button. ` ``` ` markdown shortcut now creates code blocks.
- **MDXEditor: DiffSourceToggleWrapper usage** — wrapper now wraps all toolbar contents so Source mode correctly hides rich-text buttons.
- **MDXEditor CSS completeness** — added styles for `select` (BlockTypeSelect), `pre` (code blocks), `a` (links), `hr` (thematic breaks), Source mode textarea, `::selection`.
- **Rule file cleanup** — removed old-name rule files, updated 2 rooms' `ruleDocs` references to new names.

## [0.10.23] — 2026-04-29

### Added
- **Task description WYSIWYG editor** — MDXEditor integration with lazy loading (~250KB gzip, only loaded on Task detail page). Replaces textarea + preview toggle with inline rich-text editing. Supports headings, lists, quotes, tables, links, code blocks, markdown shortcuts. Floating toolbar appears on focus.
- **"Tasks Are Living Records" principle** — added to ssot.md. Task descriptions are enriched by each actor (append, don't overwrite).

### Changed
- **Context Limit renamed** — "Context Limit" → "Messages on Activation" with descriptive hint text.
- **Task event message spacing** — unified with regular message spacing (`mt-3`).
- **update_task tool description** — added "preserve previous content and append" guidance.
- **Rule files renamed** — `member-universal-principles.md`, `member-ssot.md`, `team-dev-protocol.md`, `team-lite-protocol.md`.

### Tests
- **Release validation**: `npm run build` ✅; `npm test -- tests/unit` 285/285 ✅.

## [0.10.22] — 2026-04-28

### Added
- **Lite team template** — `templates/teams/lite-team/` with 3 members (architect as leader, developer, qa). Suited for libraries, CLI tools, services, and SDK projects without PM/Designer overhead.

### Changed
- **ssot.md decoupled from role names** — task management rules now use generic terms (Creator, Assignee, Verifier) instead of hardcoded role names (PM, Developer, QA). Enables reuse across different team compositions.
- Added `.bossmode-attachments/` to `.gitignore`.

## [0.10.21] — 2026-04-28

### Fixed
- **Summarizer keepCount=0 ignored** — `body.keepCount || 50` treated `0` as falsy, always defaulting to 50. Fixed with `??` (nullish coalescing) in both API route and auto-summary config.
- **Summarization completion message** — now reports how many messages were kept as raw text (e.g., "Latest 50 message(s) kept as raw text for ongoing context"), or nothing when keepCount=0.

## [0.10.20] — 2026-04-28

### Fixed
- **P0: Attachment upload crash on HTTP + LAN IP** — `crypto.randomUUID()` requires Secure Context (HTTPS or localhost). Replaced with `Date.now() + Math.random()` fallback for upload item IDs.

## [0.10.19] — 2026-04-28

### Fixed
- **Upload retry on error** — errored/cancelled items show a Retry button; clicking resets to pending for re-upload on next Send.
- **Preserve errored items after send** — `clearSuccessful()` replaces `clearAll()` so only done items are removed; errors stay visible for retry.
- **Cancel all button** — header shows "Cancel all" during multi-file uploads to abort all in-flight transfers at once.
- **Visual polish** — cancel button text label, adjusted opacity/saturation for status colors, error message in tooltip, progress bar aria-label.

## [0.10.18] — 2026-04-28

### Added
- **Stream-based file upload** — backend uses `pipeline(req → hash transform → writeStream)` with zero memory buffering. Temp file written first, renamed on completion, cleaned up on error/abort. Max upload size raised to 1GB.
- **Real upload progress** — XHR-based `uploadWithProgress()` client with `upload.onprogress` percentage reporting. New `useUpload` hook manages per-file state (pending/uploading/done/error/cancelled).
- **Upload cancellation** — `AbortController` integration; cancel button on each uploading file removes it and cleans up server temp files.
- **AttachmentUploader component** — dedicated upload UI with per-file progress bars, status indicators, error display. Replaces inline 64px grid in MessageInput.

### Refactored
- **Backend modules extracted**: `path-security.ts` (whitelist + symlink defense), `attachment-store.ts` (stream storage + hash naming), `uploads.ts` (HTTP routes), `agent-attachments.ts` (agent tool path validation + copy).
- **Frontend modules extracted**: `upload-client.ts` (XHR wrapper), `useUpload.ts` (state hook), `AttachmentUploader.tsx` (UI component).
- **MessageInput.tsx** — ~350 lines → ~200 lines; all upload logic delegated to useUpload hook.
- **workspace.ts** — attachment routes removed (moved to uploads.ts).
- **GET attachments** — now streams via `createReadStream().pipe(res)` instead of `readFileSync`.

### Tests
- Added: `path-security.test.ts` (7 cases: whitelist, symlink, size, invalid input).
- **Release validation**: `npm run build` ✅; `npm test -- tests/unit` 285/285 ✅.

## [0.10.17] — 2026-04-28

### Security
- **Fix symlink escape in agent attachments** — `isAllowedAttachmentPath` now uses `realpathSync` to resolve symlinks before whitelist comparison. Previously, a symlink inside an allowed directory pointing to a sensitive file (e.g., `/etc/passwd`) would pass the path check. All allowed prefixes are also resolved via `realpathSync` for cross-platform correctness (macOS `/tmp` → `/private/tmp`).

### Tests
- Updated agent attachment tests to use real temp files + symlink escape test case.
- **Release validation**: `npm run build` ✅; `npm test -- tests/unit` 278/278 ✅.

## [0.10.16] — 2026-04-28

### Added
- **Agent chat attachments** — `chat` tool now accepts `attachments: string[]` parameter (local file paths). Files are validated (path whitelist + size limit), copied to room attachments directory, and rendered as attachment indicators in chat. Allowed paths: room working directory, `/tmp/`, and knowledge docs.
- **Upload file size pre-validation** — files exceeding 100MB are rejected at selection time with a user-visible error toast (was: silent failure).
- **Upload progress indicator** — multi-file uploads show "Uploading 2/4..." in the input placeholder.

### Fixed
- **Upload failure silent swallow** — upload errors now display a toast message instead of silently returning.
- **MAX_UPLOAD_SIZE increased** — 50MB → 100MB per file.

### Tests
- Added: agent attachment path validation (6 cases: allowed dirs, system paths, traversal).
- **Release validation**: `npm run build` ✅; `npm test -- tests/unit` 278/278 ✅.

## [0.10.15] — 2026-04-28

### Added
- **Knowledge document download** — Download button on document detail page. Pure client-side Blob download, no backend route needed.

## [0.10.14] — 2026-04-28

### Fixed
- **Markdown table rendering in code blocks** — Prism markdown grammar splits table pipe syntax into per-token line breaks. `markdown`/`md` code blocks now skip Prism and render as plain `<pre>` text.

## [0.10.13] — 2026-04-27

### Fixed
- **Search jump to old messages** — clicking a search result for a message not in the current loaded range now fetches a window around that message via `?around=<msgId>` API parameter. Previously failed silently.
- **Search bar stays open after jump** — removed unconditional `onCloseSearch` call from `scrollToMessage`. Users can now click multiple search results to jump between them. Close via X / Esc only.

### Added
- **"Jump to latest" button** — floating button appears when viewing historical messages (after a search jump). Clicking returns to the live message stream.
- **`around` query parameter** for `GET /api/rooms/:id/messages` — returns a window of messages centered on the target ID.
- **History view mode** in `useRoom` — `inHistoryView` state suppresses WS message appends while reading old context.

### Tests
- Added: `getMessages around` (4 cases: centered window, not found, near start, near end).
- **Release validation**: `npm run build` ✅; `npm test -- tests/unit` 272/272 ✅.

## [0.10.12] — 2026-04-27

### Added
- **SSOT rule** — unified Source of Truth protocol (`docs/rules/ssot.md`): Task Board = work status, Knowledge = decisions & artifacts, Chat = ephemeral process. Includes task management lifecycle, references usage, assign auto-activation, and knowledge discipline.

### Changed
- Rule files restructured: `task-management-protocol.md` → `ssot.md` (broader scope); Knowledge Discipline moved from `dev-team-protocol.md` into `ssot.md`.

## [0.10.11] — 2026-04-27

### Fixed
- **P0: Pi CLI extension crash on startup** — centralized tool description constants were referenced but not defined in the generated extension file. Fixed by inlining constants via `JSON.stringify` into the template. All agents can now start correctly.

## [0.10.10] — 2026-04-27

### Added
- **Task references field** — tasks can link to knowledge docs (`docs/...`) or URLs (`https://...`). Soft links that degrade gracefully when files are moved/deleted. UI shows references section in task detail page with add/remove, plus 📎 badge on task cards.
- **Task assign auto-activation** — assigning a task to an agent in the room automatically activates that agent via the existing mention → router flow. Guards: no self-activation, no duplicate activation on same assignee, human users are not activated.
- **Centralized MCP tool descriptions** — new `src/shared/mcp-tool-descriptions.ts` shared by mcp-server and pi-cli runtimes. Each tool now has usage guidance and side-effect documentation.
- **Task management protocol rule** — `docs/rules/task-management-protocol.md` injected into agent prompts.

### Tests
- Added: task references CRUD (4 cases), auto-activation logic (8 cases), tool description quality (5 cases).
- **Release validation**: `npm run build` ✅; `npm test -- tests/unit` 268/268 ✅.

## [0.10.9] — 2026-04-27

### Added
- **Keyboard navigation for popup menus** — `/` slash command menu (AgentTab) and `@` mention popup (MessageInput) now support ↑/↓ to move selection, Enter/Tab to confirm, Esc to close. Mouse hover syncs with keyboard highlight. Consistent with Slack/Discord/Notion interaction patterns.

## [0.10.8] — 2026-04-27

### Fixed
- **Remove confusing fake URL path under task title** — the internal route path (`/rooms/.../tasks/...`) shown below the task title was meaningless to users. Removed in favor of existing breadcrumb + sidebar metadata.

## [0.10.7] — 2026-04-27

### Fixed
- **Attachment preview/download not working** — browser `<img src>` and `<a download>` don't send Authorization headers, so attachment GET requests were blocked by auth middleware (401). Added auth bypass for attachment GET routes. Security: filenames are sha256 hashes + roomIds are UUIDs (≈60-bit entropy), unguessable in LAN deployment.

### Tests
- Added unit test for attachment auth bypass regex pattern.
- **Release validation**: `npm run build` passed; `npm test -- tests/unit` passed (251/251).

## [0.10.6] — 2026-04-27

### Added
- **Lightweight attachment indicator** — attachments display as compact file rows (icon + filename + Preview/Download on hover) instead of inline images. Image preview via click-to-open lightbox with Esc/overlay close.

### Fixed
- **Dark mode message hover visibility** — hover background changed from near-invisible `bg-zinc-900/20` to perceptible `bg-zinc-800/40`.
- **Sidebar section dividers unified** — all sections (Members/Agents/Skills/Knowledge) now have consistent top borders.
- **Attachment button vertical alignment** — Paperclip button sized to match textarea height for proper center alignment.

### Tests
- **Release validation**: `npm run build` passed (tsc zero errors).
- **Release note**: `feat: lightweight attachment indicator with preview/download; fix: dark mode message hover visibility; fix: sidebar section dividers unified; fix: attachment button vertical alignment with input`.

## [0.10.5] — 2026-04-27

### Fixed
- **Built-in team update false positive** — update detection now compares template content hash instead of version number. If template content hasn't changed between versions, no update is shown. Existing installs without `templateHash` are silently backfilled on first check.

### Tests
- Added unit test: version bump without template change → no update shown.
- Updated existing tests to change template content when testing update detection.
- **Release validation**: `npm run build` passed (tsc zero errors); `npm test -- tests/unit` passed (248/248).
- **Release note**: `fix: built-in team update false positive — use template content hash instead of version comparison`.

## [0.10.4] — 2026-04-27

### Added
- **Task board `review` status** — four-column kanban: Todo / In Progress / Review / Done. Status cycle updated across board, list, detail, and agent tools.
- **Attachment preview cards in chat** — image attachments render as thumbnails in a grid below message text; non-image attachments show as file icon cards. Visual separation between message body and attachment area.

### Fixed
- **Task detail back navigation** — returns to the correct origin (Chat tab if entered from chat system message, Tasks tab if from board, All Tasks if from global page).
- **Task event system messages styled as cards** — bordered card with status badge, replacing plain inline text.
- **PATCH API undefined field overwrite** — already fixed in 0.10.1, now also defensive in store layer.

### Refactor
- **Task detail page visual overhaul** — Linear-style full-width layout with sidebar metadata, chip pickers for status/priority/assignee, auto-grow description textarea, inline header chips.

### Tests
- **Release validation**: `npm run build` passed (tsc zero errors); `npm test -- tests/unit` passed (247/247).
- **Release note**: `feat: review status + attachment preview + task UI polish`.

## [0.10.3] — 2026-04-27

### Fixed
- **Tasks tab missing for existing rooms** — localStorage saved old tab configs without the tasks tab. Restore logic now auto-migrates by inserting the tasks tab at index 1 if absent.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `fix: auto-migrate saved tabs to include tasks tab`.

## [0.10.2] — 2026-04-26

### Fixed
- **Tasks tab not visible in room** — tab bar React key for the tasks tab was `undefined` (missing type check), causing it to not render. Fixed key to `"tasks"`.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `fix: tasks tab key rendering in room tab bar`.

## [0.10.1] — 2026-04-26

### Added
- **Task board** — lightweight task management per room: board (three-column kanban) and list views with drag-and-drop status changes, quick-add inline creation, full-page Linear-style task detail with dual-column layout, global All Tasks page with cross-room aggregation and filtering.
- **Agent task tools** — three new MCP/pi-cli tools: `create_task`, `update_task`, `list_tasks` for agents to manage tasks programmatically.
- **Task event system messages** — task creation, status changes, and deletion emit structured system messages in room chat with click-to-jump navigation to task detail.
- **Sidebar All Tasks entry** — global task overview accessible from sidebar.

### Fixed
- **PATCH API field preservation** — updating a single task field (e.g. status) no longer wipes other fields (title, priority, assignee). Conditional patch construction ensures only explicitly provided fields are modified.

### Tests
- Added 8 unit tests for task-store CRUD and cross-room aggregation.
- **Release validation**: `npm run build` passed (tsc zero errors); `npm test -- tests/unit` passed (247/247).
- **Release note**: `feat: task board — lightweight task management per room with board/list views, drag-and-drop status changes, full-page task detail (Linear-style), quick add, global All Tasks page, agent tools (create_task/update_task/list_tasks), task event system messages with click-to-jump; fix: PATCH API field preservation`.

## [0.10.0] — 2026-04-25

### Added
- **Message search** — keyword, sender, and time range filtering in room chat. Accessible via the search icon in the room header or Ctrl/Cmd+F. Results show in real-time with keyword highlighting and click-to-jump navigation.
- **query_room_messages enhanced** — agent tool now supports `query`, `from`, `after`, `before` search filter params and an `output: "file"` mode that writes results to a temp markdown file, bypassing the 25K truncation limit for large result sets.

### Tests
- Added 10 unit tests for message search logic.
- **Release validation**: `npm run build` passed (tsc zero errors); `npm test -- tests/unit` passed (239/239).
- **Release note**: `feat: message search — keyword, sender, and time range filtering in room chat; agent tool query_room_messages enhanced with search filters and file output mode for large result sets; search UI with real-time results, keyword highlighting, and click-to-jump`.

## [0.9.11] — 2026-04-25

### Added
- **"User Intent is Supreme" universal agent principle** — all agents now recognize user commands as the highest priority. When user instructions conflict with team rules, agents briefly flag the conflict once, then execute upon confirmation without repeated questioning.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `feat: add "User Intent is Supreme" to universal agent principles — user commands take highest priority over team rules with single confirmation`.

## [0.9.10] — 2026-04-25

### Fixed
- **Knowledge page white screen on first visit** — `mobileView` useMemo referenced `folderNode` before its declaration (TDZ error), crashing the component on every mount. Regression introduced in v0.9.4.
- **Room and private chat draft persistence** — new `useDraft` hook backs input with localStorage so draft text survives page switches, tab changes, and browser refresh. MessageInput and AgentChat both upgraded.

### Build
- **TypeScript type checking added to build** — `tsc --noEmit` now runs before `vite build`, preventing type errors from shipping silently.

### Tests
- Added 7 unit tests for `useDraft` localStorage persistence contract.
- **Release validation**: `npm run build` passed (including tsc); `npm test -- tests/unit` passed (229/229).
- **Release note**: `fix: knowledge page white screen on first visit (TDZ error from v0.9.4); feat: draft persistence for room and private chat input (survives page switch and refresh); build: add tsc type checking to prevent type errors from shipping`.

## [0.9.9] — 2026-04-25

### Added
- **VS Code-style folder picker** — redesigned FolderPicker with editable PathBar (direct path input + OK button + Home icon), keyboard navigation (↑↓ navigate, Enter open, Cmd+Enter select, Backspace up, Esc cancel), blue selected state, hidden folder dimming; breadcrumbs removed for cleaner UI.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `feat: VS Code-style folder picker with PathBar, keyboard navigation, blue selection; remove breadcrumbs`.

## [0.9.8] — 2026-04-25

### Fixed
- **Folder picker fails on first open** — `~` path was not expanded to the actual home directory, causing a 404 error on initial open. Backend now normalizes tilde paths; frontend no longer sends literal `~`.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `fix: folder picker fails on first open — tilde path not expanded to home directory`.

## [0.9.7] — 2026-04-25

### Added
- **Folder picker for room working directory** — the Create Room dialog now has a folder-browse button next to the cwd input. Users can navigate their home directory tree and select a folder visually instead of typing paths manually. Manual input is still supported alongside the picker.

### Tests
- **Release validation**: `npm run build` passed; `npm test -- tests/unit` passed.
- **Release note**: `feat: folder picker for room working directory — browse and select folders visually instead of typing paths manually`.

## [0.9.6] — 2026-04-25

### Fixed
- **Context usage state leaking across rooms** — switching rooms no longer carries over context usage data from the previous room (useRoom now resets all state on every roomId change, not just on null).
- **Summarizer hidden from create room member list** — the summarizer system member is no longer shown in the CreateRoomDialog member selector.
- **Input dialogs no longer close on overlay click** — dialogs with user input (CreateRoom, RoomSettings, AddMember, prompt, ReviewDialog) now require explicit Cancel/Esc to close; click-outside prevention via Sheet `closeOnOverlayClick=false` + mousedown/mouseup origin check.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `fix: context usage state leaking across rooms when switching; fix: hide summarizer from create room member list; fix: prevent input dialogs from closing on overlay click`.

## [0.9.5] — 2026-04-24

### Fixed
- **Sidebar collapse button hidden on mobile** — the collapse/expand toggle no longer appears on mobile where it had no visible effect (sidebar is drawer-mode, collapsed is forced false) and would silently pollute the desktop collapsed state in localStorage.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `fix: hide sidebar collapse button on mobile (no effect in drawer mode, polluted desktop state)`.

## [0.9.4] — 2026-04-24

### Added
- **Mobile responsive adaptation** — complete mobile/desktop dual-layout: Sidebar/Members drawer navigation, MobileTopBar, touch targets ≥44px, Sheet dialogs, long-press context menu, edge swipe gestures, Activity card simplification, safe-area inset, iOS Safari input zoom prevention, viewport-fit=cover, 100dvh support.

### Refactor
- **Agent prompt positive principles** — all 5 agent templates and team protocol refactored from NEVER/ALWAYS constraint style to positive Working Principles, giving models clear guidance on best behavior rather than restriction lists.

### Tests
- **Release validation**: `npm run build` passed; `npm test -- tests/unit` passed.
- **Release note**: `feat: mobile responsive adaptation — drawer navigation, touch targets, Sheet dialogs, long-press context menu, edge swipe gestures, activity card simplification, safe-area inset, iOS Safari input zoom prevention; refactor: agent prompt governance — replace NEVER/ALWAYS constraints with positive Working Principles across all 5 agent templates and team protocol`.

## [0.9.3] — 2026-04-24

### Fixed
- **pi-cli extension generation escape regression** — two `\\n\\n` sequences in the generated extension template were erroneously simplified to `\n\n` (literal newlines) in 0.9.1, causing a `ParseError: Unterminated string constant` crash on agent startup after restart.

### Tests
- Added regression guards to `pi-cli-args.test.ts`: asserts `\\n\\n` is present in the generated extension output (both `truncate()` helper and `query_room_messages` join separator).
- **Release validation**: `npm run build` passed; `npm test -- tests/unit/pi-cli-args.test.ts` passed.
- **Release note**: `fix: pi-cli extension generation escape regression introduced in 0.9.1 that caused ParseError on agent startup`.

## [0.9.2] — 2026-04-24

### Fixed
- **Message envelope footer now action-required** — changed reply footer wording to explicit command style to reduce agent bare-text output and enforce chat tool usage.

### Tests
- **Release validation**: `npm run build` passed; focused unit coverage for envelope/footer behavior passed.
- **Release note**: `fix: message envelope footer changed to action-required command style to prevent agents from outputting bare text instead of calling chat tool`.

## [0.9.1] — 2026-04-24

### Added
- **Knowledge agent tools retired** — removed agent-facing knowledge CRUD/search tools; agents now operate directly on filesystem documents with preserved project document tree index injection in prompts.
- **Knowledge UI file management** — added context menu actions (move/rename/delete), Move-to dialog, inline rename, drag-and-drop move, multi-select with batch operations, plus backend support for folder move/delete.

### Fixed
- **Agent activity card spacing** — restored consistent spacing between activity cards after prior scroll-container wrapper change.

### Tests
- **Release validation**: `npm run build` passed; `npm test -- tests/unit` passed.
- **Release note**: `feat: knowledge agent tools retired — agents now use filesystem directly with document tree index injection; feat: knowledge UI file management — context menu (move/rename/delete), move-to dialog, inline rename, drag-and-drop, multi-select with batch operations, folder move/delete support; fix: agent activity card spacing`.

## [0.9.0] — 2026-04-23

### Added
- **Built-in team versioning** — added end-to-end update management for built-in agents/skills/rules: update detection, review flow, selective apply, three-level dismiss, and Settings toggle.
- **Knowledge folder overview + sidebar navigation** — clicking top-level Knowledge folders now opens an immediate folder landing/index view with consistent sidebar-linked navigation feedback.

### Fixed
- **Chat auto-scroll reliability** — multi-line input growth and private-chat working indicator now keep timelines pinned to latest content when user is near bottom.
- **Markdown image rendering for attachment-style paths** — improved rendering path consistency for image content in chat flows.

### Tests
- **Release validation**: `npm run build` passed; `npm test -- tests/unit` passed.
- **Release note**: `feat: built-in team versioning — auto-detect updates, review changes, three-level dismiss, Settings toggle; feat: knowledge folder overview with sidebar navigation; fix: chat auto-scroll on multi-line input and private chat working indicator; fix: markdown image rendering with attachment URL resolution`.

## [0.8.11] — 2026-04-23

### Added
- **Agent prompt governance overhaul** — upgraded core role prompts with stronger collaboration contracts: PM coordination-first behavior and no code-based root-cause work, Architect root-cause depth evaluation (surface patch vs proper fix), Developer problem-escalation thresholds, Designer visual-code delivery model, and QA adversarial testing + test-gap audit expectations.
- **Team protocol v2** — expanded Dev Team collaboration rules with explicit role boundaries, dedicated Bug Fix / UI Fix / Release workflows, onboarding responsibilities, and knowledge-discipline structure guidance.
- **Universal agent principles rule** — introduced cross-role rule document with three default execution principles: *Act First, Ask Second*; *See It Through*; *Be Concise*.
- **Team template seeding generalization** — rule seed logic now scans all team templates under `templates/teams/` instead of hardcoding a single file.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `feat: agent prompt governance — role boundaries, root cause investigation, problem escalation, designer code delivery, adversarial QA; team protocol v2 with bug fix/UI fix/release workflows, onboarding, knowledge discipline; universal agent principles rule (act first, see it through, be concise); seed logic scans all team templates`.

## [0.8.10] — 2026-04-23

### Fixed
- **Unified timestamp style across chat surfaces** — aligned timestamp typography and placement across room chat, private chat, and activity views (`11px`, `tabular-nums`, consistent inline positioning next to sender/header labels).

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `fix: unified timestamp style across room chat, private chat, and activity views (11px, tabular-nums, consistent positioning)`.

## [0.8.9] — 2026-04-22

### Fixed
- **Defensive idle transition after prompt resolve** — added post-`prompt()` fallback state recovery in `activateAgent` and idle-path `steerAgent` so `WORKING → IDLE` transition is guaranteed even for handle implementations that do not emit `agent_end` events (e.g. mock/test handles).

### Tests
- Revalidated member state machine acceptance coverage (SM-1/SM-2) and private-steer working-path behavior.
- **Release note**: `fix: defensive idle transition after prompt resolve ensures WORKING→IDLE state change for all handle types`.

## [0.8.8] — 2026-04-22

### Added
- **Homepage room-card hub replaces empty welcome state** — the default no-selection view now shows a focused "Your Rooms" home with clickable room cards (unread indicator, cwd tail, member count, per-room working badge) plus a dashed `New Room` action; empty installations now show a `Get started` variant.

### Fixed
- **Sidebar item icon language unified** — removed per-item icons for Members/Agents/Skills and eliminated emoji usage in list rows, keeping only Room `#` markers and section-level icons for clearer hierarchy and consistent visual rhythm.
- **Sidebar section spacing consistency** — removed extra internal divider between Members and Agents so section spacing follows one consistent pattern.

### Tests
- **Release validation**: `npm run build` passed.
- **Release note**: `feat: homepage room card list replaces empty welcome state; fix: unified sidebar item icons (remove emoji, remove per-item icons for members/agents/skills)`.

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
