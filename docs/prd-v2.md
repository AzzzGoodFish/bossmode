# PRD v2: Bossmode — 人与 Agent 协同办公平台

**Author**: PM
**Status**: Draft
**Date**: 2026-03-21
**定位**: 从 "AI 团队聊天室" 升级为 "人与 Agent 协同办公平台"

---

## 1. 产品愿景

**一句话**：像飞书管理人的团队一样，管理 Agent 的团队。

**核心差异化**：市面上的 AI 工具是"人用 AI"，Bossmode 是"人带 AI 团队做事"。用户是老板，Agent 是员工，平台提供组织架构、协作规范、知识管理、项目空间。

**核心设计原则 — 框架思维**：

Bossmode 不是一个固定功能的工具，而是一个**人与 Agent 协同工作的框架**。

这意味着：
1. **不预设场景**：平台不替用户决定"怎么用 Agent"。dev-team 只是一个预置模板，用户可以组建任何团队、定义任何协作流程、创造任何工作模式。
2. **一切可组合**：Agent、Skill、Team、知识库都是独立的积木。用户自由组合，平台不设限。一个 Agent 可以属于多个 Team，一个 Skill 可以被多个 Agent 使用，一个知识库可以被多个 Room 共享。
3. **平台提供能力，用户定义用法**：平台的价值是提供组织、协作、知识管理的基础设施，而不是具体的业务逻辑。具体怎么协作、怎么分工，由用户通过 Team Prompt 和 Agent 定义来决定。
4. **充满可能性**：今天是 dev 场景，明天可能是内容创作、研究分析、客户服务。框架要足够通用，不被某个场景绑死。

这个原则贯穿所有设计决策 — 当面临"做成固定功能"还是"做成可配置能力"的选择时，永远选后者。

**三层产品模型**：

```
┌─────────────────────────────────────────────┐
│              Chat Room（项目工作室）           │
│   = Team + 项目知识 + 工作目录                │
│   群聊（协作）+ 私聊（监控）+ 归档（沉淀）     │
└──────────────┬──────────────────┬────────────┘
               │                  │
   ┌───────────▼──────┐  ┌───────▼──────────┐
   │   Team（组织）    │  │  项目知识（上下文） │
   │ 成员 + 协作规范   │  │ 背景 + 约定 + 历史 │
   └───────────┬──────┘  └──────────────────┘
               │
   ┌───────────▼──────────────────┐
   │  Agent + Skill（个体能力）    │
   │  身份 + 职责 + 技能插件       │
   └──────────────────────────────┘
```

---

## 2. 模块设计

### 2.1 Agent 模块 — "简历库"

Agent 是角色定义，描述一个角色的身份、职责、行为规范。类比：**员工简历**。

Agent 本身不包含运行时配置（模型、执行器等），只定义"这个角色是谁、能做什么"。

#### 2.1.1 Agent 定义

沿用 openteam 的 Markdown + Frontmatter 格式：

```yaml
---
name: architect
description: "系统设计、代码架构、技术决策"
avatar: 🏗️  # 可选，用于 UI 展示
tags: [dev, design]  # 分类标签
---

# Architect

## Identity
...

## Responsibilities
...

## Discipline
...
```

注意：`model`、`skills` 等运行时配置不在 Agent 定义中，而在 Member 配置中（见 §2.5）。

#### 2.1.2 Agent 管理界面

| 功能 | 描述 |
|------|------|
| Agent 列表 | 所有已配置的 agent，显示名称、描述、标签 |
| Agent 详情 | 查看/编辑 agent 的完整定义（Markdown 编辑器） |
| Agent 创建 | 名称 → 角色描述 → 标签 → 预览 |
| Agent 模板 | 预置模板库（从 openteam 迁移） |
| Agent 导入/导出 | 支持 .md 文件导入导出，兼容 openteam 格式 |

#### 2.1.3 Agent 存储

```
~/.bossmode/agents/
├── architect.md
├── developer.md
├── pm.md
├── qa.md
└── designer.md
```

### 2.2 Skill 模块 — "技能库"

Skill 是 Agent 的能力插件，类比飞书的"应用/工具"。

#### 2.2.1 Skill 定义

```yaml
---
name: implementation-planning
description: "将架构设计转化为文件级别的实现计划"
tags: [planning, architecture]  # 用户自定义标签，用于分类和检索
---

# Implementation Planning

## When to Use
需要将高层设计转化为具体的实现步骤时...

## Process
### Step 1: 分析架构设计
...
### Step 2: 拆解为文件级任务
...

## Output Format
...

## Anti-Patterns
...
```

#### 2.2.2 Skill 管理界面

| 功能 | 描述 |
|------|------|
| Skill 列表 | 所有 skill，按标签分类展示（用户自定义标签） |
| Skill 详情 | 查看/编辑 skill 内容 |
| Skill 创建 | Markdown 编辑器，支持从模板创建 |
| Skill 绑定 | 在 agent 详情页中勾选 skill，或在 skill 页中选择适用的 agent |
| Skill 模板库 | 预置 openteam 的 12 个 skill + 社区贡献（未来） |

#### 2.2.3 Skill 加载机制

Agent 被激活时，根据其 `skills` 列表，将对应 skill 内容注入到 system prompt 中。可选策略：
- **全量注入**：所有 skill 一次性加入上下文（简单，但占 token）
- **按需加载**：给 agent 一个 `load_skill` 工具，需要时自己加载（省 token，但需要 agent 有判断力）
- **场景匹配**：根据用户消息内容自动匹配相关 skill（智能，但复杂）

v2 建议先做全量注入，后续优化为按需加载。

#### 2.2.4 Skill 存储

```
~/.bossmode/skills/
├── requirement-clarification/
│   └── SKILL.md
├── implementation-planning/
│   └── SKILL.md
├── test-plan-design/
│   └── SKILL.md
└── ...
```

### 2.5 Member 模块 — "岗位任命"

Member 是 Agent 定义的运行时配置实例。类比：Agent 是**简历**，Member 是**岗位任命**。

同一个 Agent 定义可以创建多个 Member（不同配置）。Room 和 Team 中选择的是 Member，不是 Agent。

#### 2.5.1 Member 定义

```json
{
  "name": "architect",
  "agent": "architect",           // 引用 Agent 定义
  "model": "claude-sonnet-4-20250514",
  "runtime": "pi-cli",           // 执行器：pi-cli / claude-cli
  "skills": [                    // 绑定的 Skill
    "codebase-mapping",
    "implementation-planning"
  ],
  "thinkingLevel": "medium"      // 思考级别
}
```

#### 2.5.2 Member 管理界面

| 功能 | 描述 |
|------|------|
| Member 列表 | 所有已配置的 member，显示名称、关联 agent、model、runtime、skill 数 |
| Member 创建 | 选 Agent → 配置 model、runtime、skills、thinking level |
| Member 编辑 | 修改运行时配置（不影响 Agent 定义） |
| Member 状态 | 跨 room 的工作状态：空闲 / 在哪个 room 工作中 |

#### 2.5.3 Member 存储

```
~/.bossmode/members.json
```

#### 2.5.4 Agent → Member → Room 的关系

```
Agent（简历）     → 定义角色的身份、职责、行为
  ↓ 配置
Member（岗位）    → 赋予运行时能力：模型、执行器、技能、思考级别
  ↓ 加入
Room/Team（工作室）→ 在具体项目中工作
```

---

### 2.3 Team 模块 — "组织架构"

Team 定义一组 Member 的协作规范，类比飞书的"部门/项目组"。Team 中引用的是 Member，不是 Agent。

#### 2.3.1 Team 定义

```yaml
---
name: dev-team
description: "全栈开发团队"
leader: pm
members:
  - pm
  - architect
  - developer
  - qa
---
```

加上 Team Prompt（协作规范）：

```markdown
# Dev Team 协作规范

## 工作模式

### Coordinated Workflow（完整功能请求）
User → PM 澄清需求 → Architect 设计（QA 同步设计测试）
→ PM 确认 → Developer 实现 → QA 验收 → PM 报告

### Direct Tasking（小任务）
User 直接 @ 某个 agent，独立完成。

## 角色分工表
| 话题 | 找谁 |
|------|------|
| 需求、优先级、范围 | PM |
| 技术设计、架构 | Architect |
| 代码实现、单元测试 | Developer |
| 验收测试、质量 | QA |

## 沟通规则
- 交接时说明：做了什么、产出在哪、需要对方做什么
- 有阻塞立即上报，不要憋着
- 问题逐级上报：QA/Developer → Architect/PM → PM
```

#### 2.3.2 Team 管理界面

| 功能 | 描述 |
|------|------|
| Team 列表 | 所有团队，显示名称、成员数、Leader |
| Team 详情 | 成员列表 + 协作规范（可编辑） |
| Team 创建 | 选成员 → 指定 Leader → 编写/选择协作规范模板 |
| Team 模板 | 预置模板：dev-team、content-team、research-team 等 |
| Team 与 Room 关联 | 创建 room 时选 team → 自动拉入成员 + 注入协作规范 |

#### 2.3.3 协作规范的注入方式

Member 被 @ 激活时，各层上下文通过不同方式传递给 CLI runtime：

| 层 | 传递方式 | 说明 |
|---|---------|------|
| Agent 定义 | `--system-prompt` | 角色身份、职责、纪律。稳定不变，利于 LLM cache |
| Skill | CLI 原生 `--skill <path>` | 渐进式加载：描述在 prompt，全文按需读取 |
| Team Prompt | `--append-system-prompt` | 协作规范 + 角色分工。变更频率低 |
| 项目知识 | `query_knowledge` 工具 | 按需查询，不拼入 prompt，避免破坏 LLM cache |
| 群聊增量 | prompt/steer 消息 | 激活时发送增量消息 |

**设计取舍**：知识库不自动注入 prompt，agent 需要主动查询。这是 token 效率和自动化程度的取舍。可通过 Team Prompt 加入指引（如"工作前先查询项目知识库"）来缓解。

#### 2.3.4 Team 存储

```
~/.bossmode/teams/
├── dev-team/
│   ├── team.json          # 成员配置
│   └── team-prompt.md     # 协作规范
├── content-team/
│   ├── team.json
│   └── team-prompt.md
└── ...
```

### 2.4 知识库模块 — "飞书文档"

知识库是工作室级别的共享上下文，类比飞书的"知识库/文档"。知识文档是平台的独立资产，不依附于任何工作室，可以被多个工作室共享引用。

#### 2.4.1 知识来源

| 来源 | 说明 |
|------|------|
| 用户手动添加 | 项目背景、技术栈、架构约定、开发规范 |
| 自动沉淀 | 群聊归档摘要、关键决策记录、Agent 工作产出 |
| 文件关联 | 工作目录中的 README.md、CLAUDE.md 等自动识别 |

#### 2.4.2 知识结构

```yaml
project:
  name: "Bossmode"
  description: "人与 Agent 协同办公平台"
  tech_stack: "TypeScript, React, pi-mono"

knowledge_entries:
  - title: "架构设计"
    content: "分层架构：Web Layer → Message Router → Agent Manager..."
    source: "architect"  # 谁贡献的
    created_at: "2026-03-18"

  - title: "API 约定"
    content: "所有 API 返回 JSON，认证用 Bearer token..."
    source: "developer"
    created_at: "2026-03-19"

  - title: "测试策略"
    content: "三层测试：API + WebSocket + Playwright E2E..."
    source: "qa"
    created_at: "2026-03-19"
```

#### 2.4.3 知识管理界面

| 功能 | 描述 |
|------|------|
| 知识库列表 | 所有项目知识库，按项目/room 分类 |
| 知识条目管理 | 增删改查知识条目 |
| 自动关联 | 创建 room 时关联已有知识库，或新建 |
| 知识共享 | 同一知识库可被多个 room 共享 |
| 自动沉淀 | Agent 通过专用工具将工作产出写入知识库 |

#### 2.4.4 知识注入方式

Agent 被激活时，项目知识作为 system prompt 的一部分注入。知识量大时需要策略：
- **全量注入**（知识条目少时）
- **相关性检索**（知识条目多时，基于用户消息做语义匹配，类似 RAG）
- **Agent 主动查询**（给 agent 一个 `query_knowledge` 工具）

v2 建议先做全量注入 + agent 主动查询工具。

#### 2.4.5 项目知识存储

```
~/.bossmode/knowledge/
├── bossmode/
│   ├── knowledge.json     # 知识条目索引
│   └── entries/
│       ├── architecture.md
│       ├── api-conventions.md
│       └── test-strategy.md
└── another-project/
    └── ...
```

---

## 3. 产品体验愿景

以下是产品的完整使用图景：

### 3.1 启动与资源发现

打开 Bossmode，软件自动读取 `~/.bossmode/agents/` 下的 Agent 和 Skill 定义。用户在界面中直接看到所有可用的 Agent 和 Skill，可以查看内容、自由添加新的。

### 3.2 组建团队

用户自由组建 Team：选择 Agent 成员、指定角色分工、编写协作规范。组建好的 Team 有一个**组织视图**，让用户一眼理解团队组成和协作规范 — 谁负责什么、怎么配合、问题找谁。

### 3.3 创建工作室

通过选择 Agent 或 Team + 指定工作目录来创建**工作室**（即 Chat Room）。工作室 = 一个项目空间，承载团队协作的全过程。

### 3.4 群聊协作 — 天然的共享上下文

在工作室中，用户和 Agent 团队沟通。消息中的 `@` 触发目标 Agent 去了解新的群聊消息，然后执行任务。

**这是 Bossmode 最核心的设计**：群聊天然就是共享上下文。用户和 PM 聊需求、和设计师聊视觉、和架构师聊框架，聊好后直接 `@developer @qa`，他们就自动知道之前聊了什么内容、做了什么决策。不需要像传统工具那样手动转述或触发消息传递。

### 3.5 项目知识 — 平台级资产

在工作室中，用户和 Agent 们有共同的**项目知识文档**。创建好的知识文档是 Bossmode 的平台资产，就像飞书文档一样 — 独立于对话存在，可以被查看、编辑、跨工作室共享。Agent 工作时可以查询知识库，也可以将产出沉淀为新的知识条目。

### 3.6 私聊 — 超越传统办公软件的设计

在飞书中，私聊就是私聊，群聊就是群聊，完全隔离。但在 Bossmode 中，私聊承载了三重角色：

1. **透视镜** — 查看 Agent 的工作详情：思考过程、工具调用、完整回复。群聊只展示 Agent 通过 chat 工具发出的结果，私聊展示完整的工作过程。
2. **任务跟踪器** — 看某个 Agent 在这个工作室中做了什么，所有工作记录持久化保存。
3. **快速通道** — 有小需求时直接私聊完成，不用在群聊中大费周章通知所有人。

### 3.7 场景示例

**场景 A：开发团队做新功能**
1. 创建工作室 → 选 dev-team → 指定项目目录
2. @pm 描述需求 → PM 看到消息，开始澄清需求、写 PRD
3. PM 完成后在群聊发出 PRD → @architect 看到 PRD + 之前所有讨论
4. Architect 设计架构 → @developer @qa 看到所有上下文直接开始工作
5. 全程无需手动传话，群聊就是共享记忆

**场景 B：内容团队做营销方案**
1. 创建工作室 → 选 content-team（策划 + 文案 + 设计）
2. @策划 讨论目标人群 → @文案 写 copy → @设计 出视觉
3. 每个 Agent 都能看到之前的讨论，理解完整上下文

**场景 C：个人助手快速处理**
1. 不创建 Team，直接选一个 Agent 创建工作室
2. 私聊完成小任务 — 代码审查、文档总结、数据分析
3. 需要时再拉入其他 Agent

**场景 D：知识沉淀与复用**
1. 团队在工作室 A 中完成了架构设计
2. Architect 将设计决策写入项目知识库
3. 新建工作室 B（同一项目的另一个方面）→ 关联同一个知识库
4. 新工作室中的 Agent 立即拥有之前的所有设计决策

---

## 4. 导航与信息架构

### 4.1 左侧导航重设计

```
┌──────────────────────┐
│  Bossmode             │
│                       │
│  📬 Chat Rooms        │  ← 当前核心功能
│    # project-a        │
│    # project-b        │
│                       │
│  🤖 Agents            │  ← Agent 定义管理
│                       │
│  👤 Members           │  ← Member 配置管理
│                       │
│  🧩 Skills            │  ← Skill 管理入口
│                       │
│  👥 Teams             │  ← Team 管理入口
│                       │
│  📚 Knowledge         │  ← 项目知识入口
│                       │
│  ⚙️ Settings          │  ← 全局设置
│                       │
│  ─────────────────    │
│  🟢 fish    Sign out  │
└──────────────────────┘
```

点击各模块 → 右侧主区域切换为对应管理界面。Chat Rooms 保持现有体验。

### 4.2 Room 创建流程升级

```
创建 Room
  ├── Room 名称
  ├── 工作目录
  ├── 选择 Team（可选，选了自动填充 Member）
  │     └── 或手动勾选 Member
  ├── 关联知识库（可选）
  │     ├── 选择已有知识库
  │     └── 或创建新知识库
  └── 创建
```

---

## 5. 上下文传递架构

Member 被 @ 激活时，各层上下文通过不同机制传递给 CLI runtime：

```
┌─────────────────┬──────────────────────┬──────────────────────────┐
│       层        │      传递方式         │          说明            │
├─────────────────┼──────────────────────┼──────────────────────────┤
│ Agent 定义      │ --system-prompt      │ 稳定不变，利于 LLM cache │
│ Skill           │ CLI --skill <path>   │ 渐进式：描述在 prompt，  │
│                 │                      │ 全文按需读取             │
│ Team Prompt     │ --append-system-prompt│ 协作规范，变更频率低     │
│ 项目知识        │ query_knowledge 工具  │ 按需查询，不拼 prompt    │
│ 群聊增量        │ prompt/steer 消息    │ 激活时发送增量消息       │
└─────────────────┴──────────────────────┴──────────────────────────┘
```

**核心设计决策**：Bossmode 是零 agent 引擎依赖的纯管理平台。它不内嵌 LLM 调用逻辑，而是通过 CLI runtime（pi-cli / claude-cli）执行 agent。这意味着：
- 切换 LLM 引擎只需更换 Member 的 runtime 配置
- Skill 加载利用 CLI 原生能力，不重复造轮子
- 项目知识通过工具查询而非注入 prompt，保护 LLM cache 效率

组装逻辑在 `agent-manager` 中实现，每次激活时动态构建 CLI 命令参数。

---

## 6. 新增 Agent 工具

除了现有的 `chat`（发群聊）和 `mention`（@ 其他 agent），新增：

| 工具 | 描述 |
|------|------|
| `save_knowledge` | 将工作产出写入项目知识库（标题 + 内容） |
| `query_knowledge` | 查询项目知识库中的条目 |
| `load_skill` | 按需加载未预装的 skill（CLI 原生支持后可移除） |

---

## 7. 实现阶段

### Phase 1：Agent + Skill 管理（基础）
- Agent CRUD 界面 + Markdown 编辑器
- Skill CRUD 界面 + Agent 绑定
- Agent 模板库（从 openteam 迁移 5 个）
- Skill 模板库（从 openteam 迁移 12 个）
- Skill 注入到 agent system prompt
- 左侧导航新增 Agents / Skills 入口

### Phase 2：Team 模块
- Team CRUD 界面 + 协作规范编辑器
- Team 模板库（dev-team）
- Room 创建时选 Team → 自动填充成员
- Team prompt 注入到 agent system prompt
- 左侧导航新增 Teams 入口

### Phase 3：项目知识
- 知识库 CRUD 界面 + 知识条目管理
- Room 关联知识库
- 知识注入到 agent system prompt
- `save_knowledge` / `query_knowledge` 工具
- 归档摘要自动写入知识库
- 左侧导航新增 Knowledge 入口

### Phase 4：体验打磨
- Agent 跨 room 状态总览
- 知识库语义检索（RAG）
- Skill 按需加载
- 导入/导出（agent、skill、team、知识库）
- UI-14 图片消息
- UI-21 侧边栏收起

---

## 8. 与线上产品的关系

Bossmode 作为 dev 场景的试验田：
- 验证"人与 Agent 协同"的产品模型
- 打磨 Agent/Skill/Team/Knowledge 四个核心模块的交互和数据模型
- 积累实际使用中的设计经验和 edge cases
- 沉淀可复用的协作规范和 skill 库

验证通过的设计和代码，迁移到线上产品时：
- 前端组件库可复用（React + Tailwind）
- 后端 Agent 编排层可复用（runtime 抽象已做）
- 协作规范和 skill 内容直接复用
- 数据模型（agent/skill/team/knowledge）直接复用

---

## 9. Open Questions

- [ ] Skill 加载策略：v2 先全量注入，token 消耗可接受吗？需要测算
- [ ] 知识库的大小限制：多少条目 / 多大内容量才需要引入 RAG？
- [ ] 多用户场景（线上产品）：Agent 定义是全局共享还是用户私有？
- [ ] Agent 的模型配置：是否支持运行时切换模型？（runtime 抽象已支持）
- [ ] 协作规范的版本管理：team prompt 修改后，已有 room 是否跟随更新？
