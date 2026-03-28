# Bossmode v2 Architecture

**Author**: Architect
**Status**: Draft
**Date**: 2026-03-21

---

## 1. 设计概述

v2 在 v1 的聊天室基础上新增四个模块：Agent 管理、Skill 管理、Team 管理、知识库。核心架构不变（Server → Core → Store），通过扩展 Store 层 + API 层 + 前端页面实现，不重写。

**最大的内部变化**是 System Prompt 组装 — 从单层（agent 定义 + 房间成员列表）变为五层动态拼接。

---

## 2. 数据模型

### 2.1 类型扩展（`shared/types.ts`）

```typescript
// ── Agent 定义（扩展现有） ──

interface AgentDefinition {
  name: string;
  model: string;
  description: string;
  systemPrompt: string;
  // v2 新增
  skills: string[];        // skill 名称列表
  avatar?: string;         // emoji 或图片路径
  tags: string[];          // 分类标签
}

// ── Skill 定义（新增） ──

interface SkillDefinition {
  name: string;
  description: string;
  tags: string[];
  content: string;         // SKILL.md 的 body（去掉 frontmatter）
}

// ── Team 定义（新增） ──

interface TeamDefinition {
  name: string;
  description: string;
  leader: string;          // agent name
  members: string[];       // agent names
}

interface TeamWithPrompt extends TeamDefinition {
  teamPrompt: string;      // team-prompt.md 的内容
}

// ── 知识库（新增） ──

interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}

interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;          // 谁贡献的（agent name 或 "user"）
  createdAt: number;
  updatedAt: number;
}

// ── Room（扩展现有） ──

interface Room {
  id: string;
  name: string;
  cwd: string;
  members: string[];
  createdAt: number;
  // v2 新增
  teamName?: string;           // 关联的 team
  knowledgeBaseId?: string;    // 关联的知识库
}
```

### 2.2 存储结构

```
~/.bossmode/
├── config.json                    # 不变
├── bossmode.pid                   # 不变
├── agents/                        # 不变，格式兼容
│   ├── pm.md                      # frontmatter 新增 skills/avatar/tags 字段
│   ├── architect.md
│   └── ...
├── skills/                        # 新增
│   ├── codebase-mapping/
│   │   └── SKILL.md
│   ├── implementation-planning/
│   │   └── SKILL.md
│   └── ...
├── teams/                         # 新增
│   ├── dev-team/
│   │   ├── team.json              # { name, description, leader, members }
│   │   └── team-prompt.md         # 协作规范 markdown
│   └── ...
├── knowledge/                     # 新增
│   ├── <kb-id>/
│   │   ├── knowledge.json         # { id, name, description, createdAt }
│   │   └── entries/
│   │       ├── <entry-id>.md      # 知识条目
│   │       └── ...
│   └── ...
└── rooms/                         # 不变，room.json 新增 teamName/knowledgeBaseId 字段
```

### 2.3 关联关系

```
Agent ──N:M── Skill       (agent.skills[] 引用 skill name)
Team  ──1:N── Agent       (team.members[] 引用 agent name)
Room  ──N:1── Team        (room.teamName 引用 team name，可选)
Room  ──N:1── KnowledgeBase (room.knowledgeBaseId 引用 kb id，可选)
KnowledgeBase ──1:N── KnowledgeEntry
```

所有引用都是 name/id 字符串，无外键约束 — 符合文件系统存储的松耦合特性。引用断裂（如 skill 被删但 agent 还引用）在加载时静默忽略。

---

## 3. System Prompt 组装引擎

### 3.1 五层拼接

Agent 被 @ 激活时，system prompt 按以下顺序拼接：

```
┌─────────────────────────────────────┐
│ Layer 1: Agent 定义                  │  ← agent.systemPrompt
│ 身份、职责、纪律                      │
├─────────────────────────────────────┤
│ Layer 2: Skill 内容                  │  ← 遍历 agent.skills[]，加载每个 skill.content
│ 工作指南、流程                        │     格式：## Skill: {name}\n{content}
├─────────────────────────────────────┤
│ Layer 3: Team 协作规范               │  ← room.teamName → team.teamPrompt
│ 工作模式、角色分工、沟通规则           │     如果 room 没关联 team，跳过
├─────────────────────────────────────┤
│ Layer 4: 项目知识                    │  ← room.knowledgeBaseId → 所有 entries
│ 背景、约定、历史决策                  │     如果 room 没关联知识库，跳过
│                                     │     格式：## Knowledge: {title}\n{content}
├─────────────────────────────────────┤
│ Layer 5: 环境信息                    │  ← 动态生成
│ Room 成员列表、工具说明               │     现有 buildSystemPrompt() 的内容
└─────────────────────────────────────┘
```

### 3.2 实现位置

组装逻辑从 `runtime/pi-mono.ts` 的 `buildSystemPrompt()` 上移到 `agent-manager.ts`。原因：system prompt 的内容（skill、team、knowledge）是业务层的事，不是 runtime 层的事。Runtime 只负责把最终的 prompt 字符串传给引擎。

```typescript
// agent-manager.ts

function assembleSystemPrompt(
  agentDef: AgentDefinition,
  room: Room,
  skills: SkillDefinition[],
  team: TeamWithPrompt | null,
  knowledgeEntries: KnowledgeEntry[],
  roomMembers: string[],
): string {
  const parts: string[] = [];

  // Layer 1: Agent definition
  parts.push(agentDef.systemPrompt);

  // Layer 2: Skills
  if (skills.length > 0) {
    parts.push("---\n\n# Skills\n");
    for (const skill of skills) {
      parts.push(`## Skill: ${skill.name}\n\n${skill.content}\n`);
    }
  }

  // Layer 3: Team prompt
  if (team) {
    parts.push(`---\n\n# Team: ${team.name}\n\n${team.teamPrompt}\n`);
  }

  // Layer 4: Knowledge
  if (knowledgeEntries.length > 0) {
    parts.push("---\n\n# Project Knowledge\n");
    for (const entry of knowledgeEntries) {
      parts.push(`## ${entry.title}\n\n${entry.content}\n`);
    }
  }

  // Layer 5: Environment (room context, tools guide)
  parts.push(buildEnvironmentPrompt(agentDef.name, roomMembers));

  return parts.join("\n");
}
```

### 3.3 对 Runtime 接口的影响

`CreateAgentOpts.systemPrompt` 不变 — agent-manager 把组装好的完整 prompt 传给 runtime。Runtime 不感知五层结构。

---

## 4. 现有代码改造方案

### 4.1 可直接扩展（不改现有逻辑）

| 模块 | 扩展内容 |
|------|---------|
| `shared/types.ts` | 新增 SkillDefinition, TeamDefinition, TeamWithPrompt, KnowledgeBase, KnowledgeEntry 类型；扩展 AgentDefinition 和 Room |
| `server/api.ts` | 新增 CRUD 路由（agents, skills, teams, knowledge）|
| 前端 `web/src/` | 新增管理页面（AgentsPage, SkillsPage, TeamsPage, KnowledgePage）|
| `web/src/components/Sidebar.tsx` | 新增导航项 |

### 4.2 需要重构

| 模块 | 改什么 | 为什么 |
|------|--------|--------|
| `store/agent-defs.ts` | **frontmatter 解析器升级** | 当前 `parseFrontmatter()` 把所有值当 `string`，无法解析 YAML 列表（`skills: [a, b]`）。需要支持数组和可选字段。 |
| `agent-manager.ts` | **system prompt 组装上移** | 从 `runtime/pi-mono.ts` 搬到这里，变成五层拼接。`getOrCreate()` 中需要加载 skills、team、knowledge。 |
| `runtime/pi-mono.ts` | **去掉 buildSystemPrompt()** | prompt 组装不再是 runtime 的事。runtime 只接收最终字符串。 |
| `CreateRoomDialog.tsx` | **扩展创建流程** | 新增 Team 选择（自动填充成员）+ 知识库关联 |

### 4.3 新增 Store 模块

| 文件 | 职责 |
|------|------|
| `store/skill-store.ts` | Skill CRUD，从 `~/.bossmode/skills/` 读写 |
| `store/team-store.ts` | Team CRUD，从 `~/.bossmode/teams/` 读写 |
| `store/knowledge-store.ts` | 知识库 + 知识条目 CRUD，从 `~/.bossmode/knowledge/` 读写 |

### 4.4 新增 Agent 工具

在 `runtime/pi-mono.ts`（和未来的 `runtime/claude-cli.ts`）中注册：

| 工具 | 参数 | 行为 |
|------|------|------|
| `save_knowledge` | `{ title: string, content: string }` | 写入当前 room 关联的知识库 |
| `query_knowledge` | `{ query?: string }` | 查询当前 room 关联的知识库条目列表（v2 全文匹配，v2.1 语义检索） |

这两个工具需要知道 roomId → knowledgeBaseId 的关联。通过 `CreateAgentOpts` 传入 `knowledgeBaseId`，或者通过回调注入。

**设计决策**：和 chat/mention 一样，用回调方式：

```typescript
interface AgentCallbacks {
  onChat: (message: string) => Promise<void>;
  onMention: (target: string, message: string) => Promise<void>;
  getApiKey: (provider: string) => Promise<string | undefined>;
  // v2 新增
  onSaveKnowledge?: (title: string, content: string) => Promise<void>;
  onQueryKnowledge?: (query?: string) => Promise<KnowledgeEntry[]>;
}
```

Runtime 层根据回调是否存在决定是否注册工具。agent-manager 提供回调实现（读写 knowledge-store）。

---

## 5. Frontmatter 解析器升级

当前的 `parseFrontmatter()` 是最小实现 — 按行 split，`key: value` 映射到 `Record<string, string>`。v2 需要支持：

```yaml
skills:
  - codebase-mapping
  - implementation-planning
tags: [dev, design]
avatar: 🏗️
```

**方案选择**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| A: 引入 `yaml` npm 包 | 完整 YAML 支持，不操心边界情况 | 新依赖 |
| B: 自己扩展解析器 | 零依赖 | 要处理缩进列表、内联列表、引号等 |
| C: 引入 `gray-matter` | 专门做 frontmatter 的库 | 新依赖，但很轻 |

**建议 A**：引入 `yaml` 包。理由：
1. Skill 和 Team 的 frontmatter 也需要解析，解析需求会越来越复杂
2. `yaml` 包体积小（40KB），无子依赖，维护成熟
3. 零依赖原则适用于运行时外部服务（DB、Redis），解析库是合理的开发依赖

```typescript
import { parse as parseYaml } from "yaml";

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  return { meta: parseYaml(match[1]) ?? {}, body: match[2].trim() };
}
```

返回类型从 `Record<string, string>` 变为 `Record<string, unknown>`，调用方按需类型断言。

---

## 6. openteam 迁移方案

### 6.1 迁移内容

| 资源 | 源路径 | 目标路径 | 数量 |
|------|--------|---------|------|
| Agent 定义 | `openteam/examples/dev-team/*.md` | `~/.bossmode/agents/*.md` | 5 个（pm, architect, developer, qa, designer） |
| Skill 定义 | `openteam/examples/dev-team/skills/*/SKILL.md` | `~/.bossmode/skills/*/SKILL.md` | 12 个 |
| Team 定义 | `openteam/examples/dev-team/team-prompt.md` | `~/.bossmode/teams/dev-team/` | 1 个 |

### 6.2 迁移方式

**不做运行时自动迁移**。改为：

1. 把 openteam 的 agent/skill/team 定义打包到 bossmode 仓库的 `templates/` 目录
2. `bossmode on` 首次启动时，如果 `~/.bossmode/agents/` 为空，自动从 `templates/` 复制预置内容
3. 后续 UI 中的"模板"功能直接读 `templates/` 目录

```
bossmode/
├── templates/
│   ├── agents/                    # 预置 agent 定义
│   │   ├── pm.md
│   │   ├── architect.md
│   │   ├── developer.md
│   │   ├── qa.md
│   │   └── designer.md
│   ├── skills/                    # 预置 skill
│   │   ├── requirement-clarification/SKILL.md
│   │   └── ... (12 个)
│   └── teams/                     # 预置 team
│       └── dev-team/
│           ├── team.json
│           └── team-prompt.md
```

### 6.3 格式兼容

openteam 的 agent 定义格式和 bossmode 完全兼容（都是 YAML frontmatter + Markdown）。唯一需要确认的是 frontmatter 字段名一致性 — openteam 已经用了 `name`, `description`, `skills`，和 PRD 定义的完全一致。

---

## 7. API 设计

### 7.1 新增 REST 路由

```
# Agent 管理
GET    /api/agents                    # 列表（已有，需扩展返回 skills/tags）
GET    /api/agents/:name              # 详情（含完整 systemPrompt）
POST   /api/agents                    # 创建（接收 markdown 内容）
PUT    /api/agents/:name              # 更新
DELETE /api/agents/:name              # 删除
GET    /api/agents/templates          # 模板列表

# Skill 管理
GET    /api/skills                    # 列表
GET    /api/skills/:name              # 详情
POST   /api/skills                    # 创建
PUT    /api/skills/:name              # 更新
DELETE /api/skills/:name              # 删除
GET    /api/skills/templates          # 模板列表

# Team 管理
GET    /api/teams                     # 列表
GET    /api/teams/:name               # 详情（含 teamPrompt）
POST   /api/teams                     # 创建
PUT    /api/teams/:name               # 更新
DELETE /api/teams/:name               # 删除
GET    /api/teams/templates           # 模板列表

# 知识库
GET    /api/knowledge                 # 列表
POST   /api/knowledge                 # 创建知识库
GET    /api/knowledge/:id             # 知识库详情
DELETE /api/knowledge/:id             # 删除知识库
GET    /api/knowledge/:id/entries     # 条目列表
POST   /api/knowledge/:id/entries     # 添加条目
PUT    /api/knowledge/:id/entries/:eid # 更新条目
DELETE /api/knowledge/:id/entries/:eid # 删除条目
```

### 7.2 Room 创建扩展

`POST /api/rooms` 请求体新增可选字段：

```json
{
  "name": "bossmode-dev",
  "cwd": "/home/fish/dev/llm/bossmode",
  "members": ["pm", "architect"],
  "teamName": "dev-team",
  "knowledgeBaseId": "kb-xxx"
}
```

如果提供 `teamName`，服务端自动填充 `members`（如果前端没传）。

---

## 8. 前端页面结构

```
web/src/pages/
├── Login.tsx              # 不变
├── Main.tsx               # 不变（群聊主界面）
├── AgentsPage.tsx         # 新增：Agent 列表 + CRUD
├── AgentDetail.tsx        # 新增：Agent 详情/编辑（Markdown 编辑器）
├── SkillsPage.tsx         # 新增：Skill 列表 + CRUD
├── SkillDetail.tsx        # 新增：Skill 详情/编辑
├── TeamsPage.tsx          # 新增：Team 列表 + CRUD
├── TeamDetail.tsx         # 新增：Team 详情/编辑
├── KnowledgePage.tsx      # 新增：知识库列表
└── KnowledgeDetail.tsx    # 新增：知识库条目管理
```

Sidebar 从 section 模式（Rooms / Contacts）变为模块导航模式（Chat Rooms / Agents / Skills / Teams / Knowledge / Settings），点击切换右侧主区域内容。

需要引入前端路由。建议 `react-router-dom`（标准选择），或更轻量的基于 state 的 page switcher（当前没有路由库）。

**建议**：先用 state-based page switcher（`activePage: "rooms" | "agents" | "skills" | ...`），避免引入 URL routing 的复杂性。Bossmode 是 SPA，不需要 URL deep linking。

---

## 9. Phase 技术依赖分析

```
Phase 1: Agent + Skill
├── frontmatter 解析器升级（yaml 包）     ← 阻塞所有 Phase
├── store/skill-store.ts                  ← 独立
├── agent-defs.ts 扩展（skills/tags）     ← 依赖解析器升级
├── API 路由：agents CRUD + skills CRUD   ← 依赖 store
├── 前端：AgentsPage + SkillsPage         ← 依赖 API
├── system prompt Layer 1+2 拼接          ← 依赖 skill-store
└── templates/ 目录 + 首次启动复制        ← 独立

Phase 2: Team
├── store/team-store.ts                   ← 独立
├── API 路由：teams CRUD                  ← 依赖 store
├── 前端：TeamsPage                       ← 依赖 API
├── Room 创建流程扩展（选 team）           ← 依赖 team-store
├── system prompt Layer 3 拼接            ← 依赖 team-store
└── Room 类型扩展（teamName）             ← 小改

Phase 3: Knowledge
├── store/knowledge-store.ts              ← 独立
├── API 路由：knowledge CRUD              ← 依赖 store
├── 前端：KnowledgePage                   ← 依赖 API
├── Room 创建流程扩展（关联知识库）        ← 依赖 knowledge-store
├── system prompt Layer 4 拼接            ← 依赖 knowledge-store
├── save_knowledge / query_knowledge 工具  ← 依赖 knowledge-store + runtime 回调扩展
├── Room 类型扩展（knowledgeBaseId）       ← 小改
└── 归档摘要写入知识库                    ← 依赖 knowledge-store

Phase 4: 体验打磨
├── 无阻塞依赖，都是独立优化
```

**关键路径**：frontmatter 解析器升级 → Phase 1 的一切 → Phase 2/3 可并行（如果有两个开发者的话，但我们只有一个 Developer，所以串行）

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Skill 全量注入 token 消耗 | 12 个 skill 可能占几万 token，压缩有效上下文 | v2 先做，观察实际消耗。如果过大，在 agent 定义中标记"核心 skill"只注入这些 |
| 知识库条目过多 | 全量注入不现实 | v2 先做全量（条目少时够用）+ query_knowledge 工具。Phase 4 引入 RAG |
| frontmatter 解析器变更影响现有 agent 加载 | 已有的 agent 定义可能因解析器变更而行为不同 | 新解析器向后兼容 — 没有 skills/tags 字段时 默认为空数组 |
| 前端页面增多导致复杂度上升 | 代码膨胀 | 每个管理页面结构相似（列表 + 详情），抽取共享组件（ListPage, DetailEditor） |
| Room.teamName 引用的 team 被删 | room 找不到 team | 静默忽略，prompt 组装跳过 Layer 3。UI 显示"Team not found" |

---

## 11. Open Questions 回应

> Skill 加载策略：v2 先全量注入，token 消耗可接受吗？

需要测算。12 个 skill 的总 token 数：每个 skill 约 1000-3000 token，12 个约 12K-36K。对 200K 上下文的模型来说可接受，但接近 10% 了。建议 agent 定义中只绑定真正需要的 skill（4-5 个），不要全绑。

> 协作规范修改后，已有 room 是否跟随更新？

**是的，自动跟随**。Room 存的是 `teamName`（引用），不是 team prompt 的快照。每次 agent 激活时都重新加载 team prompt。这意味着修改 team prompt 立即生效于所有关联 room 的后续激活。

> Agent 模型配置是否支持运行时切换？

Runtime 抽象层已支持（`dynamicModel` capability + `AgentHandle.setModel()`）。但注意：已创建的 agent 实例切换模型后，对话历史中的 token 计算可能不准。建议 v2 不在 UI 上暴露运行时切换，只支持在 agent 定义中配置默认模型。
