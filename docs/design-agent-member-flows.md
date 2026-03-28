# Design: Agent & Member 用户流程

**Author**: Designer
**Date**: 2026-03-24
**Status**: Draft — 等待 fish 确认

---

## 0. 核心问题

当前 Agent 和 Member 的使用有几个关键体验问题：

### 概念割裂
- Agent（简历）和 Member（岗位）是两个独立页面，用户需要先去 Agents 页面创建 Agent，再去 Members 页面创建 Member，关系不直观。
- 对于"我只是想加个 Agent 到 Room 里干活"的用户，这个两步流程太重了。

### Agent 创建门槛高
- 当前创建 Agent 是一个弹窗 + 裸 Markdown 编辑器，用户必须理解 frontmatter 格式。
- 没有模板，没有引导，新用户面对一片空白的 YAML + Markdown 无从下手。

### Member 与 Room 脱节
- CreateRoomDialog 里选的是 agent name，不是 Member。但实际运行需要 Member 配置（runtime、model 等）。
- 概念混淆：用户以为选了 Agent 就能用，实际上背后需要一个 Member。

### 信息层级不清
- Agent 卡片上显示 skills 数量，但 skill 绑定实际在 Member 上。
- Agent 详情页是纯文本编辑器，没有结构化展示。

---

## 1. 设计方向：Agent-first，Member 自动化

**核心原则：用户想的是"我要一个什么样的角色"，不是"我要配置一个运行时实例"。**

Member 的存在是为了"同一个 Agent 定义可以有不同运行时配置"。但在 MVP 阶段，绝大多数用户的场景是 1 Agent : 1 Member。所以：

- **Agent 是主角**，用户直接在 Agent 页面完成所有操作
- **Member 自动生成**，创建 Agent 时自动创建一个默认 Member（可在 Agent 详情里调运行时配置）
- **Members 页面变成高级视图**，面向需要"同一 Agent 多套配置"的高级用户

---

## 2. Agent 流程重设计

### 2.1 Agents 列表页

**现状**：卡片网格 + 搜索 + New Agent 按钮。基本 OK，优化细节。

**改进**：

```
┌─────────────────────────────────────────────────────────────┐
│  Agents                                        + New Agent  │
│  4 agents · 3 active in rooms                               │
│                                                             │
│  ┌─────────────────┐                                        │
│  │ 🔍 Search agents...                                │     │
│  └─────────────────┘                                        │
│                                                             │
│  ┌─────────────────┐ ┌─────────────────┐ ┌────────────────┐ │
│  │ 🏗️ architect     │ │ 💻 developer     │ │ 📋 pm          │ │
│  │                  │ │                  │ │                │ │
│  │ 系统设计、架构、  │ │ 代码实现、单元   │ │ 需求、优先级、  │ │
│  │ 技术决策         │ │ 测试             │ │ 协调           │ │
│  │                  │ │                  │ │                │ │
│  │ ┌──────┐┌──────┐│ │ ┌──────┐        │ │ ┌──────┐      │ │
│  │ │ dev  ││design││ │ │ dev  │        │ │ │ mgmt │      │ │
│  │ └──────┘└──────┘│ │ └──────┘        │ │ └──────┘      │ │
│  │                  │ │                  │ │                │ │
│  │ pi-cli · sonnet  │ │ pi-cli · sonnet  │ │ pi-cli · sonnet│ │
│  │ ● room-a        │ │                  │ │ ● room-a      │ │
│  └─────────────────┘ └─────────────────┘ └────────────────┘ │
│                                                             │
│  ┌─────────────────┐                                        │
│  │ 🧪 qa            │                                        │
│  │                  │                                        │
│  │ 测试、验收、     │                                        │
│  │ 质量把关         │                                        │
│  │                  │                                        │
│  │ ┌──────┐        │                                        │
│  │ │ dev  │        │                                        │
│  │ └──────┘        │                                        │
│  │                  │                                        │
│  │ pi-cli · sonnet  │                                        │
│  │ ● room-a        │                                        │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
```

**卡片信息层级**（从上到下）：
1. **Avatar + Name** — 14px semibold white，最显眼
2. **Description** — 12px zinc-400，1-2 行截断
3. **Tags** — 10px pill badges，zinc-800 底 zinc-500 字
4. **Runtime 概要** — 12px zinc-600，显示 `{runtime} · {model短名}`，来自默认 Member
5. **活跃状态** — 如果在某个 Room 工作中，显示绿点 + room 名

**关键变化**：
- 卡片底部新增 runtime 概要行（来自关联的 Member），让用户一眼看到这个 Agent 用什么引擎
- 新增活跃状态指示，知道哪些 Agent 正在工作
- 副标题从 "4 agents configured" 改为 "4 agents · 3 active in rooms"，强化运行感

### 2.2 Agent 创建流程

**现状**：弹窗里填 name + 裸写 markdown。门槛太高。

**重设计：两种入口**

#### 入口 A：从模板创建（推荐路径）

点击 "+ New Agent" → 弹出 Dialog：

```
┌──────────────────────────────────────────────────────┐
│  Create Agent                                    ✕   │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ Start from template                    ▾       │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ 📋       │ │ 🏗️       │ │ 💻       │            │
│  │ PM       │ │ Architect│ │ Developer│            │
│  │          │ │          │ │          │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ 🧪       │ │ 🎨       │ │ ✏️       │            │
│  │ QA       │ │ Designer │ │ Blank    │            │
│  └──────────┘ └──────────┘ └──────────┘            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

选择模板后 → 进入 Agent 详情页（已预填内容），用户可以修改后保存。

#### 入口 B：空白创建

选择 "Blank" 模板 → 进入结构化创建表单：

```
┌──────────────────────────────────────────────────────┐
│  ← Agents    New Agent                        Save   │
│                                                      │
│  ┌─ Identity ──────────────────────────────────────┐ │
│  │                                                  │ │
│  │  Name       [________________]                   │ │
│  │  Avatar     [🤖 ▾ ]                              │ │
│  │  Description[________________________________]   │ │
│  │  Tags       [+ Add tag]  ┌───┐ ┌───┐            │ │
│  │                          │dev│ │ops│            │ │
│  │                          └───┘ └───┘            │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ Runtime ───────────────────────────────────────┐ │
│  │                                                  │ │
│  │  Runtime    [pi-cli          ▾]                  │ │
│  │  Model      [sonnet____________]                 │ │
│  │  Thinking   [off ▾]                              │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ System Prompt ─────────────────────────────────┐ │
│  │                                                  │ │
│  │  ┌────────────────────────────────────────────┐  │ │
│  │  │ # Agent Name                               │  │ │
│  │  │                                            │  │ │
│  │  │ ## Identity                                │  │ │
│  │  │ ...                                        │  │ │
│  │  │                                            │  │ │
│  │  │ ## Responsibilities                        │  │ │
│  │  │ ...                                        │  │ │
│  │  └────────────────────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ Skills ────────────────────────────────────────┐ │
│  │                                                  │ │
│  │  ☐ codebase-mapping                             │ │
│  │  ☐ implementation-planning                      │ │
│  │  ☐ requirement-clarification                    │ │
│  │  ☐ test-plan-design                             │ │
│  │  ...                                            │ │
│  └──────────────────────────────────────────────────┘ │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**关键设计决策**：创建 Agent 时同时设置 Runtime 配置（实际上创建了一个同名 Member）。用户不需要知道"Member"这个概念。

### 2.3 Agent 详情页

**现状**：纯 Markdown 文本编辑器。对高级用户友好，但对新用户不友好。

**重设计：双模式 — 结构化视图 + Source 视图**

```
┌──────────────────────────────────────────────────────────────┐
│  ← Agents    architect                   Delete    Save      │
│                                                              │
│  ┌──────────┐ ┌──────────┐                                   │
│  │ Overview │ │ Source   │                                   │
│  └──────────┘ └──────────┘                                   │
│                                                              │
│  ┏━━ Overview 模式 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│  ┃                                                          ┃ │
│  ┃  ┌─ Identity ─────────────────────────────────────────┐  ┃ │
│  ┃  │ 🏗️  architect                                      │  ┃ │
│  ┃  │ 系统设计、代码架构、技术决策                         │  ┃ │
│  ┃  │ ┌───┐ ┌──────┐                                     │  ┃ │
│  ┃  │ │dev│ │design│                                     │  ┃ │
│  ┃  │ └───┘ └──────┘                                     │  ┃ │
│  ┃  └────────────────────────────────────────────────────┘  ┃ │
│  ┃                                                          ┃ │
│  ┃  ┌─ Runtime ──────────────────────────────────────────┐  ┃ │
│  ┃  │                                                     │  ┃ │
│  ┃  │  Runtime    [pi-cli          ▾]                     │  ┃ │
│  ┃  │  Model      [sonnet____________]                    │  ┃ │
│  ┃  │  Thinking   [off ▾]                                 │  ┃ │
│  ┃  │                                                     │  ┃ │
│  ┃  │  💡 这些配置决定 Agent 用什么模型和引擎执行任务      │  ┃ │
│  ┃  └────────────────────────────────────────────────────┘  ┃ │
│  ┃                                                          ┃ │
│  ┃  ┌─ Skills (3) ───────────────────────────────────────┐  ┃ │
│  ┃  │ ✅ codebase-mapping                                │  ┃ │
│  ┃  │ ✅ implementation-planning                          │  ┃ │
│  ┃  │ ✅ architecture-review                              │  ┃ │
│  ┃  │ + Add skill                                        │  ┃ │
│  ┃  └────────────────────────────────────────────────────┘  ┃ │
│  ┃                                                          ┃ │
│  ┃  ┌─ System Prompt ────────────────────────────────────┐  ┃ │
│  ┃  │                                                     │  ┃ │
│  ┃  │  (Markdown 编辑器，比现在的更高)                     │  ┃ │
│  ┃  │                                                     │  ┃ │
│  ┃  └────────────────────────────────────────────────────┘  ┃ │
│  ┃                                                          ┃ │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
│                                                              │
│  ┏━━ Source 模式 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ │
│  ┃                                                          ┃ │
│  ┃  （和现在一样的全屏 Markdown 编辑器，                     ┃ │
│  ┃   给喜欢直接编辑 frontmatter 的高级用户）                 ┃ │
│  ┃                                                          ┃ │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**关键设计**：
- **Runtime 区块直接内嵌在 Agent 详情中**，不需要跳到 Members 页面
- **两个 Tab**：Overview（结构化）和 Source（原始 Markdown），切换时双向同步
- Overview 模式下，Identity 区域可以 inline 编辑（点击 name/description 变成 input）
- System Prompt 编辑器占页面的主要空间，因为这是 Agent 的核心内容

### 2.4 Agent 空状态

当前没有 Agent 时：

```
┌──────────────────────────────────────────────────────┐
│  Agents                                              │
│                                                      │
│              🤖                                      │
│                                                      │
│         没有 Agent                                   │
│    Agent 定义角色的身份和职责                          │
│                                                      │
│    ┌──────────────────┐  ┌────────────────┐          │
│    │ 从模板快速创建    │  │  创建空白 Agent │          │
│    └──────────────────┘  └────────────────┘          │
│                                                      │
│    或者将 .md 文件放入 ~/.bossmode/agents/            │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 3. Member 流程重设计

### 3.1 定位变化

**从**："Member 是独立的管理页面" → **到**："Member 是 Agent 的运行时配置视图"

普通用户：在 Agent 详情的 Runtime 区块直接改配置，不需要知道 Member 的存在。
高级用户：Members 页面用于"同一 Agent 创建多套配置"的场景。

### 3.2 Members 页面（保留，重新定位）

侧边栏标签从 "Members" 改为 "Configurations" 或保留 "Members" 但加副标题说明。

```
┌──────────────────────────────────────────────────────────────┐
│  Members                                    + New Member     │
│  Agent 的运行时配置。大多数情况下不需要手动管理。               │
│                                                              │
│  ┌─ architect ───────────────────────────────────────────┐   │
│  │                                                        │   │
│  │  ┌──────────────────────┐  ┌──────────────────────┐   │   │
│  │  │ architect (default)  │  │ architect-fast       │   │   │
│  │  │ pi-cli · sonnet      │  │ pi-cli · haiku       │   │   │
│  │  │ thinking: medium     │  │ thinking: off        │   │   │
│  │  │ 3 skills             │  │ 0 skills             │   │   │
│  │  │ ● room-a             │  │                      │   │   │
│  │  └──────────────────────┘  └──────────────────────┘   │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ pm ──────────────────────────────────────────────────┐   │
│  │  ┌──────────────────────┐                              │   │
│  │  │ pm (default)         │                              │   │
│  │  │ pi-cli · sonnet      │                              │   │
│  │  │ thinking: off        │                              │   │
│  │  │ 0 skills             │                              │   │
│  │  │ ● room-a             │                              │   │
│  │  └──────────────────────┘                              │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**变化**：
- 按 Agent 分组展示（不是扁平列表）
- 每个 Agent 下面列出它的所有 Member 配置
- 大多数 Agent 只有一个 "(default)" Member
- 高级场景下同一 Agent 可以有多个 Member（如 architect-fast 用 haiku 做快速分析）

### 3.3 自动创建 Member

**触发时机**：
- 创建 Agent 时 → 自动创建一个同名 default Member（runtime: pi-cli, model: sonnet, skills: agent.skills）
- 不创建额外的 UI 步骤

**Runtime 默认值**：
- runtime: 优先使用 pi-cli（如果可用），否则 claude-cli
- model: `sonnet`
- thinkingLevel: `off`
- skills: 从 Agent 定义中的 `skills` 字段继承

### 3.4 Room 创建时的 Member 选择

**现状问题**：CreateRoomDialog 选的是 Agent name，与 Member 系统脱节。

**改进**：选择 Member，但展示为 Agent 名称（因为大多数 Agent 只有一个 Member）：

```
┌──────────────────────────────────────────────────────┐
│  Create Room                                     ✕   │
│                                                      │
│  Room Name    [________________________]             │
│  Work Dir     [________________________]             │
│                                                      │
│  Team         [No team — select manually    ▾]       │
│                                                      │
│  Members (3 selected)               Select All       │
│  ┌────────────────────────────────────────────────┐  │
│  │ ☑ 🏗️ architect                                 │  │
│  │   pi-cli · sonnet                              │  │
│  │                                                │  │
│  │ ☑ 💻 developer                                 │  │
│  │   pi-cli · sonnet                              │  │
│  │                                                │  │
│  │ ☑ 📋 pm                                        │  │
│  │   pi-cli · sonnet                              │  │
│  │                                                │  │
│  │ ☐ 🧪 qa                                        │  │
│  │   pi-cli · sonnet                              │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│                              Cancel     Create       │
└──────────────────────────────────────────────────────┘
```

**如果某个 Agent 有多个 Member**，展示为子选项：

```
│  ☑ 🏗️ architect                                     │
│     ● architect (default) — pi-cli · sonnet          │
│     ○ architect-fast — pi-cli · haiku                │
```

---

## 4. 完整用户旅程

### 旅程 A：新用户首次使用

```
1. 登录 → 看到空白 Chat Rooms
2. 进入 Agents 页面 → 看到空状态 → 点击"从模板快速创建"
3. 选择模板（PM / Architect / Developer / QA / Designer）
4. 自动跳转到 Agent 详情页（Overview 模式），内容已预填
5. 用户可以修改 name、description、system prompt
6. Runtime 区块已自动填好默认值（pi-cli + sonnet）
7. 点击 Save → Agent 创建 + Member 自动生成
8. 重复 2-7 创建其他 Agent
9. 回到 Chat Rooms → 创建 Room → 选择刚才创建的 Agent → 开始工作
```

### 旅程 B：日常使用 — 调整 Agent 配置

```
1. 在 Room 中发现 architect 用 sonnet 太慢
2. 侧边栏点击 Agents → 点击 architect 卡片
3. 在详情页 Runtime 区块，把 model 改为 haiku，thinking 改为 off
4. Save → 下次 @ architect 时自动生效
```

### 旅程 C：高级场景 — 同一 Agent 多套配置

```
1. 用户想让 architect 在不同 Room 用不同模型
2. 进入 Members 页面 → + New Member
3. 选 Agent: architect → Name: architect-fast → Model: haiku → Save
4. 创建 Room 时，architect 下出现两个可选配置
5. 不同 Room 选择不同的 Member
```

---

## 5. 视觉规范

### 卡片样式

```css
/* Agent 卡片 */
.agent-card {
  background: zinc-900;         /* bg-zinc-900 */
  border: 1px solid zinc-800;   /* border-zinc-800 */
  border-radius: 8px;           /* rounded-lg */
  padding: 16px;                /* p-4 */
  transition: border-color 150ms;
}
.agent-card:hover {
  border-color: zinc-700;       /* hover:border-zinc-700 */
}

/* 卡片内层级 */
.agent-name     { font: 600 14px; color: white; }
.agent-desc     { font: 400 12px; color: zinc-400; margin-top: 4px; }
.agent-tag      { font: 400 10px; color: zinc-500; bg: zinc-800; px: 6px; py: 2px; radius: 4px; }
.agent-runtime  { font: 400 12px; color: zinc-600; margin-top: 8px; }
.agent-status   { font: 400 11px; color: emerald-500; }  /* 带绿点 */
```

### Runtime badge

```
pi-cli   → bg-blue-900/50  text-blue-400    /* 蓝色系 */
claude-cli → bg-purple-900/50 text-purple-400 /* 紫色系 */
```
（沿用现有 MembersPage 的配色，保持一致）

### Section 卡片（详情页）

```css
.section {
  border: 1px solid zinc-800;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.section-title {
  font: 600 12px;
  color: zinc-400;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 12px;
}
```

### Tab 切换（Overview / Source）

```css
.tab {
  font: 500 13px;
  color: zinc-500;
  padding: 8px 16px;
  border-bottom: 2px solid transparent;
  transition: all 150ms;
}
.tab.active {
  color: white;
  border-bottom-color: blue-500;
}
```

---

## 6. 需要确认的决策

1. **Agent 创建时自动生成 Member** — 这意味着 Agent 和 Member 是 1:1 默认绑定。fish 你觉得这个简化方向对吗？还是想保持当前的两步流程？

2. **Members 页面的定位** — 是保留为"高级配置视图"，还是直接隐藏，等有需求时再做？

3. **模板库** — 目前项目里已有 openteam 的 agent 定义。需要我规划哪些模板？还是先做技术上的从 openteam 迁移？

4. **Agent 详情的双模式（Overview + Source）** — 还是只保留其中一种？Source 模式对你这种高级用户可能更好用，但新用户需要 Overview。
