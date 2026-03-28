# PRD: Bossmode

**Author**: PM
**Status**: Approved
**Priority**: P0
**Date**: 2026-03-18

---

## 1. Background & Motivation

OpenTeam 当前通过 CLI + terminal multiplexer 实现多 agent 协作，用户需要在 tmux/zellij 的多个 pane 间切换，交互成本高，无法直观观察团队全局状态。agent 的生命周期依赖 wrapper + PTY 桥接，架构复杂且难以扩展。

Bossmode 要做的是一个 **Discord 风格的 AI 团队聊天室**：用户通过 web 界面指挥 agent 团队，像老板一样工作。底层用 pi-mono 替代 CLI wrapper 作为 agent 执行器，获得对 agent 生命周期的完全控制。

核心转变：从"每个 agent 一个终端 pane"到"所有 agent 在一个聊天室里协作"。

## 2. Goals

- **Goal 1**: 用户通过 web 聊天室 @ agent 下达指令，agent 执行完毕后自动汇报，实现自然的人-agent 协作
- **Goal 2**: 提供私聊窗口让用户看到 agent 完整的工作过程（工具调用、思考），并能随时追加指令
- **Goal 3**: 一条命令启动，局域网可访问，单用户认证，开箱即用

## 3. User Scenarios

### Scenario 1: 启动 Bossmode

**User**: 开发者（fish）
**Context**: 在项目目录下，准备开始工作
**Flow**:
1. 用户执行 `bossmode on --host 0.0.0.0 --port 1234`
2. 服务启动，常驻后台，输出访问地址
3. 用户在浏览器打开地址，看到登录页
4. 输入用户名密码，进入主界面
5. 主界面显示：群聊列表（左侧）、联系人列表（agent 列表）

**Edge cases**:
- 端口被占用 → 报错提示
- 服务已在运行 → 提示已有实例，输出访问地址

### Scenario 2: 创建群聊并开始工作

**User**: 开发者
**Context**: 已登录，准备对某个项目展开工作
**Flow**:
1. 用户点击"创建群聊"
2. 选择工作目录（浏览服务端文件系统）
3. 从联系人列表勾选 agent 成员（如 pm、architect、developer、qa）
4. 确认创建，进入群聊界面
5. 群聊界面包含：消息区域、成员面板（显示成员状态）、输入框

**Edge cases**:
- 工作目录不存在或无权限 → 提示错误
- 未勾选任何 agent → 允许创建（用户可以之后拉人）

### Scenario 3: 群聊中 @ agent 下达指令

**User**: 开发者
**Context**: 在群聊中，想让 pm 分析需求
**Flow**:
1. 用户在输入框输入 `@pm 分析一下这个项目的 README，梳理出核心功能`
2. 消息出现在聊天区域，pm 的状态变为"工作中"（成员面板可见）
3. pm 开始工作（读文件、思考），期间用户可在群聊做其他事
4. pm 决定发言，调用群聊发言工具，消息出现在聊天区域
5. pm 工作完成，状态回到"空闲"

**Edge cases**:
- @ 一个不在群聊中的 agent → 提示该 agent 不是群成员
- @ 一个正在工作中的 agent → 消息注入，下次 LLM 调用时生效（steer 机制）
- `@all` → 激活群聊中所有空闲 agent，每个 agent 从各自的 last seen cursor 收增量消息

### Scenario 4: 查看 agent 私聊（详细工作过程）

**User**: 开发者
**Context**: pm 正在工作中，用户想看具体在干什么
**Flow**:
1. 用户点击成员面板中的 pm（或从联系人列表进入）
2. 打开私聊窗口，看到完整的工具调用、思考过程、中间结果
3. 用户发现方向不对，在私聊输入框追加指令：`不用看 README 了，直接看 src/ 目录结构`
4. 指令注入 pm 的上下文，pm 调整行为

**Edge cases**:
- 私聊中的用户指令不同步到群聊
- agent 空闲时私聊也可用 — 相当于单独给 agent 布置任务

### Scenario 5: Agent 间协作

**User**: 开发者（旁观）
**Context**: pm 完成需求分析，要把结论交给 architect
**Flow**:
1. pm 在群聊发言，概述需求分析结论
2. pm 使用 @ 工具激活 architect：`@architect 请基于以上需求设计技术方案`
3. architect 被激活，收到上次激活后的所有群聊新消息（包括 pm 的分析）
4. architect 状态变为"工作中"，开始设计

**Edge cases**:
- agent @ 一个正在工作中的 agent → 同样走 steer 注入

### Scenario 6: 归档历史消息

**User**: 开发者
**Context**: 群聊消息过多，想清理
**Flow**:
1. 用户手动触发归档（UI 按钮或命令）
2. 系统将历史消息压缩为摘要
3. 群聊中旧消息被摘要替代
4. 用户可通过历史记录查询工具查看原始消息

**Edge cases**:
- 归档范围：归档到什么时间点？用户可选择还是自动？→ 第一版：归档全部历史，保留最近 N 条

### Scenario 7: 动态管理群聊成员

**User**: 开发者
**Context**: 工作到一半发现需要 QA
**Flow**:
1. 用户在群聊设置中点击"添加成员"
2. 从联系人列表勾选 qa
3. qa 加入群聊，可以被 @

## 4. Requirements

### 4.1 Functional Requirements

| ID | Priority | Requirement | Acceptance Criteria |
|----|----------|-------------|---------------------|
| F1 | P0 | CLI 启动命令 `bossmode on` 启动 web 服务常驻后台 | Given 用户执行 `bossmode on --port 1234`, when 服务启动成功, then 输出访问地址且进程常驻后台 |
| F2 | P0 | 用户名密码认证登录 | Given 用户访问 web 界面, when 未登录, then 显示登录页; when 输入正确凭据, then 进入主界面 |
| F3 | P0 | 联系人列表展示所有已添加的 agent | Given 用户已添加 agent 定义, when 查看联系人列表, then 显示 agent 名称和当前状态（空闲/工作中） |
| F4 | P0 | 创建群聊：选择工作目录 + 勾选 agent 成员 | Given 用户点击创建群聊, when 选择目录和成员并确认, then 群聊创建成功，agent 以指定目录为工作目录 |
| F5 | P0 | 群聊消息区域：显示用户和 agent 的群聊消息 | Given 群聊已创建, when 用户或 agent 发送消息, then 消息实时出现在消息区域 |
| F6 | P0 | @ 激活 agent：用户在群聊 @ 某 agent 发送消息 | Given 群聊中有 pm, when 用户发送 `@pm 做需求分析`, then pm 被激活，收到上次激活后的所有新群聊消息 |
| F7 | P0 | Agent 群聊发言工具：agent 通过专用 tool 向群聊发消息 | Given agent 正在工作, when agent 调用群聊发言工具, then 消息出现在群聊消息区域 |
| F8 | P0 | Agent 间 @ 激活：agent 可以 @ 其他 agent | Given pm 正在工作, when pm 使用 @ 工具激活 architect, then architect 被激活并收到增量消息 |
| F9 | P0 | 成员面板：显示群聊成员及其状态 | Given 群聊中有 3 个 agent, when 查看成员面板, then 显示各 agent 当前状态（空闲/工作中/输入中） |
| F10 | P0 | 私聊窗口：展示 agent 完整工作过程 | Given agent 正在工作, when 用户打开该 agent 私聊, then 看到工具调用、思考过程的实时流 |
| F11 | P0 | 私聊交互：用户可在私聊中给 agent 追加指令 | Given 用户在私聊输入指令, when 发送, then 指令注入 agent 上下文（steer），不同步到群聊 |
| F12 | P0 | @all 广播激活 | Given 群聊中有多个 agent, when 用户发送 `@all 开始工作`, then 所有空闲 agent 被激活 |
| F13 | P1 | 在途 agent 消息注入 | Given agent 正在工作中, when 被 @ 或收到私聊指令, then 消息在下次 LLM 调用时生效 |
| F14 | P1 | 群聊历史归档：手动触发，压缩为摘要 | Given 用户触发归档, when 归档完成, then 旧消息替换为摘要，原始消息可通过历史查询查看 |
| F15 | P1 | 历史记录查询：查看归档前的原始消息 | Given 消息已归档, when 用户查询历史, then 能检索并查看原始消息 |
| F16 | P1 | 动态添加群聊成员 | Given 群聊已创建, when 用户添加新 agent, then 该 agent 加入群聊可被 @ |
| F17 | P1 | 群聊列表与历史群聊恢复 | Given 用户有多个群聊, when 查看群聊列表, then 显示所有群聊（含工作目录信息）；点击可继续对话 |
| F18 | P2 | 添加 agent 到联系人（agent 定义管理） | Given 用户想添加新 agent, when 使用添加功能, then agent 出现在联系人列表（具体交互后续迭代） |
| F19 | P0 | Agent 错误处理：agent 出错时群聊显示错误摘要，状态回 idle | Given agent 工作中遇到错误, when 错误发生, then 群聊显示错误摘要消息，私聊可见完整错误栈，agent 回到 idle，不自动重试 |
| F20 | P0 | LLM 模型配置：agent 定义文件中指定默认 model | Given agent 定义文件包含 model 字段, when agent 被激活, then 使用指定的模型 |
| F21 | P0 | API Key 管理：环境变量优先，配置文件兜底 | Given 用户首次启动, when 缺少必要的 API Key, then 提示用户配置；支持 `ANTHROPIC_API_KEY` 等环境变量 |

### 4.2 Non-Functional Requirements

| ID | Category | Requirement |
|----|----------|-------------|
| NF1 | 部署 | 一条命令启动，无需额外依赖（数据库、Redis 等） |
| NF2 | 网络 | 局域网可访问，支持 `--host` 和 `--port` 参数 |
| NF3 | 实时性 | 群聊消息、agent 状态变更实时推送到 web 前端（WebSocket） |
| NF4 | 持久化 | 聊天记录、群聊配置持久化到本地文件（不依赖外部数据库） |
| NF5 | 单用户 | 系统只有一个用户账号，不需要多用户权限体系 |

## 5. Non-Goals (Out of Scope)

- ❌ **多用户协作**: 这是单用户指挥台，不做权限隔离、多人实时协作
- ❌ **Taskboard / Dashboard**: 群聊即核心，不再有独立的任务看板和仪表盘
- ❌ **CLI 模式 agent**: 不再使用 wrapper + PTY 架构，完全用 pi-mono 库模式
- ❌ **MCP server 通信**: agent 间通信不走 MCP，通过 bossmode 的消息路由实现
- ❌ **移动端适配**: 第一版只考虑桌面浏览器
- ❌ **agent 定义管理的完善 UI**: 第一版添加 agent 功能最小可用，后续迭代

## 6. Dependencies & Interactions

- **pi-mono** (`~/dev/agents/pi-mono/`): agent 执行引擎，库模式集成。关键 API:
  - `Agent.prompt()` / `agent.waitForIdle()` — 执行与等待
  - `agent.steer()` — 消息注入（@ 和私聊指令）
  - `AgentTool` 接口 — 注册自定义工具（群聊发言、@ 其他 agent）
  - `createAgentSession()` — 工厂函数，指定 cwd 和工具集
  - 事件系统 — agent_start/end, tool_execution, message 事件（驱动私聊窗口实时流）
  - `SessionManager` — agent 私有对话持久化

- **openteam 设计资产复用**:
  - Agent 定义格式（name + system prompt + skills）
  - 团队协作流程理念（coordinated workflow + direct tasking）
  - 消息标记模式（`[from xxx]` 前缀）

## 7. Resolved Decisions

以下问题已在需求澄清阶段确认：

- ✅ **认证凭据**: 首次启动时交互式设置，存 `~/.bossmode/config.json`
- ✅ **归档摘要**: 用 Haiku 级 LLM 生成摘要，原始消息归档到独立文件
- ✅ **Agent 状态**: v1 只做 idle / working 两个状态，细化留 P1
- ✅ **多群聊共享目录**: 允许，同一项目可开多个群聊
- ✅ **进程管理**: 简单 daemon + PID 文件，`bossmode on` fork + 写 PID，`bossmode off` 读 PID + SIGTERM
- ✅ **Agent 定义存储**: `~/.bossmode/agents/*.md`，沿用 openteam 格式
- ✅ **模型配置**: agent 定义文件中指定默认 model，第一版不做群聊级覆盖
- ✅ **API Key**: 环境变量优先（`ANTHROPIC_API_KEY` 等），`~/.bossmode/config.json` 兜底
- ✅ **@all 增量消息**: 每个 agent 从各自的 last seen cursor 收增量

## 8. Open Questions

（已全部关闭）

- ✅ 归档时保留最近 50 条消息，后续使用中调整
