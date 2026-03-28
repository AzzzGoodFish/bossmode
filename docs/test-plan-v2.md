# Test Plan: Bossmode v2

**PRD**: `docs/prd-v2.md`
**Author**: QA
**Architecture**: `docs/architecture-v2.md`
**Status**: Ready — 架构已出，测试实现方式已细化

---

## Coverage Summary

- Total test cases: 59
- P0 (critical): 25
- P1 (important): 22
- P2 (nice-to-have): 12

---

## 1. Agent 管理 (§2.1)

### T1.1: Agent 列表展示
**Category**: Happy Path | **Priority**: P0
**Steps**: 登录后导航到 Agents 页面
**Expected**: 显示所有 `~/.bossmode/agents/*.md` 中的 agent，含名称、描述、标签、关联 skill 数

### T1.2: Agent 创建（向导式）
**Category**: Happy Path | **Priority**: P0
**Steps**: 点击创建 → 填写名称、描述 → 选择 skill → 选择模型 → 预览 → 确认
**Expected**: agent 出现在列表中；`~/.bossmode/agents/<name>.md` 文件生成，frontmatter 含 name/description/model/skills

### T1.3: Agent 编辑
**Category**: Happy Path | **Priority**: P0
**Steps**: 点击 agent → 修改描述 → 保存
**Expected**: 列表更新；.md 文件内容同步变更

### T1.4: Agent 删除
**Category**: Happy Path | **Priority**: P1
**Steps**: 删除一个 agent
**Expected**: 列表移除；.md 文件删除；已引用该 agent 的 team 不报错（降级处理）

### T1.5: Agent 文件系统同步 — 外部新增
**Category**: Integration | **Priority**: P0
**Steps**: 手动在 `~/.bossmode/agents/` 下新建 .md 文件 → 刷新 Agents 页面
**Expected**: 新 agent 出现在列表中

### T1.6: Agent 文件系统同步 — 外部修改
**Category**: Integration | **Priority**: P1
**Steps**: 手动编辑 agent .md 文件 → 刷新页面
**Expected**: 界面显示最新内容

### T1.7: Agent 模板创建
**Category**: Happy Path | **Priority**: P1
**Steps**: 选择 "PM" 模板创建 agent
**Expected**: agent 定义预填充 PM 角色的身份、职责、纪律内容

### T1.8: Agent 导入 .md 文件
**Category**: Happy Path | **Priority**: P1
**Steps**: 导入一个 openteam 格式的 agent .md 文件
**Expected**: agent 正确解析（frontmatter + body），出现在列表中

### T1.9: Agent 导出 .md 文件
**Category**: Happy Path | **Priority**: P2
**Steps**: 导出一个 agent
**Expected**: 下载的 .md 文件格式与 `~/.bossmode/agents/` 中一致

### T1.10: Agent 状态总览 — 跨 room
**Category**: Happy Path | **Priority**: P1
**Steps**: pm 在 room-A 工作中 → 查看 Agent 列表
**Expected**: pm 显示 "working in room-A"，其他 agent 显示 "idle"

### T1.11: Agent 名称冲突
**Category**: Error | **Priority**: P1
**Steps**: 创建 agent，名称与已有 agent 相同
**Expected**: 提示名称已存在，拒绝创建

### T1.12: Agent 创建 — 缺少必填字段
**Category**: Error | **Priority**: P2
**Steps**: 创建 agent 时不填名称
**Expected**: 提示必填，Create 按钮禁用

### T1.13: Agent 名称格式限制
**Category**: Error | **Priority**: P1
**Steps**: 尝试创建名称为 "产品经理"、"my agent"（含空格）、"agent@1" 的 agent
**Expected**: 全部拒绝；只允许英文字母 + 数字 + 连字符（如 "my-agent"）

---

## 2. Skill 管理 (§2.2)

### T2.1: Skill 列表展示
**Category**: Happy Path | **Priority**: P0
**Steps**: 导航到 Skills 页面
**Expected**: 显示所有 `~/.bossmode/skills/*/SKILL.md`，按标签分类

### T2.2: Skill 创建
**Category**: Happy Path | **Priority**: P0
**Steps**: 创建新 skill → 填写名称、描述、标签 → 编写内容 → 保存
**Expected**: skill 出现在列表中；`~/.bossmode/skills/<name>/SKILL.md` 生成

### T2.3: Skill 编辑
**Category**: Happy Path | **Priority**: P0
**Steps**: 编辑 skill 内容 → 保存
**Expected**: 文件同步更新

### T2.4: Skill 绑定到 Agent
**Category**: Happy Path | **Priority**: P0
**Steps**: 在 agent 详情页勾选 2 个 skill → 保存
**Expected**: agent .md frontmatter 的 `skills` 列表更新；agent 列表显示关联 skill 数 = 2

### T2.5: Skill 解绑
**Category**: Happy Path | **Priority**: P1
**Steps**: 取消勾选一个 skill → 保存
**Expected**: agent .md 的 skills 列表减少；关联数更新

### T2.6: Skill 注入到 System Prompt ⭐
**Category**: Integration | **Priority**: P0
**Steps**: 给 agent 绑定 skill → 在 room 中 @agent → 检查 agent 是否具有 skill 中描述的能力
**Expected**: agent 的行为体现 skill 中定义的工作指南

### T2.7: Skill 模板库
**Category**: Happy Path | **Priority**: P1
**Steps**: 从模板库选择 "test-plan-design" 创建 skill
**Expected**: skill 内容预填充 openteam 原始内容

### T2.8: Skill 删除 — 被 agent 引用中
**Category**: Error | **Priority**: P1
**Steps**: 删除一个被 2 个 agent 引用的 skill
**Expected**: 提示 "被 2 个 agent 引用，确认删除？" → 确认后删除 skill 文件 + 自动从 2 个 agent 的 frontmatter skills 列表中移除

### T2.9: Skill 文件系统同步
**Category**: Integration | **Priority**: P1
**Steps**: 手动创建 `~/.bossmode/skills/new-skill/SKILL.md` → 刷新
**Expected**: 新 skill 出现在列表中

---

## 3. Team 管理 (§2.3)

### T3.1: Team 创建
**Category**: Happy Path | **Priority**: P0
**Steps**: 创建 team → 选成员 pm/architect/developer → 指定 pm 为 leader → 编写协作规范
**Expected**: team 出现在列表中；`~/.bossmode/teams/<name>/team.json` + `team-prompt.md` 生成

### T3.2: Team 编辑 — 成员变更
**Category**: Happy Path | **Priority**: P1
**Steps**: 向 team 添加 qa → 保存
**Expected**: team.json members 更新

### T3.3: Team 编辑 — 协作规范变更
**Category**: Happy Path | **Priority**: P1
**Steps**: 编辑 team-prompt.md 内容 → 保存
**Expected**: 文件同步更新

### T3.4: Team 模板创建
**Category**: Happy Path | **Priority**: P1
**Steps**: 选择 "dev-team" 模板创建 team
**Expected**: 成员预填充 pm/architect/developer/qa，协作规范预填充 coordinated workflow + direct tasking

### T3.5: Room 创建时选 Team → 自动填充成员 ⭐
**Category**: Integration | **Priority**: P0
**Steps**: 创建 room → 选择 dev-team
**Expected**: 成员列表自动填充为 pm/architect/developer/qa；用户可追加或移除

### T3.6: Team Prompt 注入到 System Prompt ⭐
**Category**: Integration | **Priority**: P0
**Steps**: 用 dev-team 创建 room → @pm → 检查 pm 是否知道协作规范
**Expected**: pm 知道工作模式（coordinated workflow）、角色分工（需求找 PM、技术找 Architect）

### T3.7: Team 删除
**Category**: Happy Path | **Priority**: P2
**Steps**: 删除 team
**Expected**: team 目录删除；已关联 room 不受影响（room 保留原有成员）

### T3.8: Team 成员引用不存在的 Agent
**Category**: Error | **Priority**: P2
**Steps**: team 中引用了 "designer" 但该 agent 不存在
**Expected**: 创建 room 时提示 "designer agent not found"，但不阻塞创建

---

## 4. 知识库 (§2.4)

### T4.1: 知识库创建
**Category**: Happy Path | **Priority**: P0
**Steps**: 导航到 Knowledge → 创建新知识库 → 填写名称
**Expected**: 知识库出现在列表中；`~/.bossmode/knowledge/<name>/knowledge.json` 生成

### T4.2: 知识条目 CRUD
**Category**: Happy Path | **Priority**: P0
**Steps**: 添加知识条目（标题 + 内容）→ 编辑 → 删除
**Expected**: 条目正确增删改；`entries/*.md` 文件同步

### T4.3: Room 关联知识库
**Category**: Happy Path | **Priority**: P0
**Steps**: 创建 room 时选择已有知识库
**Expected**: room 关联成功；room 详情显示关联的知识库

### T4.4: 知识库跨 Room 共享 ⭐
**Category**: Integration | **Priority**: P0
**Steps**: 知识库 K1 关联到 room-A 和 room-B → 在 room-A 中添加知识条目 → 在 room-B 中验证
**Expected**: room-B 的 agent 能获取到在 room-A 中添加的知识条目

### T4.5: 知识注入到 System Prompt ⭐
**Category**: Integration | **Priority**: P0
**Steps**: room 关联知识库 K1（含 3 个条目）→ @pm → 检查 pm 是否知道知识库内容
**Expected**: pm 回答时引用知识库中的信息

### T4.6: save_knowledge 工具 ⭐
**Category**: Integration | **Priority**: P0
**Steps**: @pm 让其工作 → pm 产出工作结果 → 检查知识库
**Expected**: pm 使用 save_knowledge 工具将产出写入知识库；知识库中出现新条目

### T4.7: query_knowledge 工具
**Category**: Integration | **Priority**: P1
**Steps**: 知识库中有 5 个条目 → @agent 问一个需要查询知识库的问题
**Expected**: agent 使用 query_knowledge 工具检索并引用正确的知识条目

### T4.8: 归档摘要自动写入知识库
**Category**: Integration | **Priority**: P1
**Steps**: room 关联知识库 → 触发归档
**Expected**: 归档摘要自动作为新的知识条目写入知识库

### T4.9: 知识库删除
**Category**: Happy Path | **Priority**: P2
**Steps**: 删除知识库
**Expected**: 知识库目录删除；已关联 room 不报错（降级为无知识）

### T4.10: 知识条目为空的知识库
**Category**: Boundary | **Priority**: P2
**Steps**: room 关联一个空知识库 → @agent
**Expected**: agent 正常工作，无报错（知识部分为空）

---

## 5. System Prompt 组装 (§5) ⭐ 核心测试区域

### T5.1: 五层组装正确性
**Category**: Integration | **Priority**: P0
**Steps**:
1. 创建 agent（有定义 + 2 个 skill）
2. 创建 team（有协作规范）
3. 创建知识库（有 2 个条目）
4. 用该 team 创建 room，关联知识库
5. @agent → 检查 agent 行为
**Expected**: agent 同时具备：自身角色认知 + skill 能力 + 团队协作规范 + 项目知识

### T5.2: 无 Team 无知识库的 Room
**Category**: Boundary | **Priority**: P1
**Steps**: 不选 team、不关联知识库创建 room → @agent
**Expected**: agent 正常工作（只有 agent 定义 + skill），不报错

### T5.3: Agent 无 Skill
**Category**: Boundary | **Priority**: P1
**Steps**: agent 未绑定任何 skill → @agent
**Expected**: agent 正常工作（skill 部分为空）

### T5.4: Skill 内容更新后生效
**Category**: Integration | **Priority**: P1
**Steps**: 修改 skill 内容 → 在新 room 中 @agent
**Expected**: agent 使用更新后的 skill 内容（不是缓存的旧内容）

### T5.5: Team Prompt 更新后即时生效 ⭐
**Category**: Integration | **Priority**: P0
**Steps**:
1. 用 dev-team 创建 room → @pm → 验证 pm 知道 coordinated workflow
2. 修改 dev-team 的协作规范（如改角色分工表）
3. 在同一 room 中再次 @pm
**Expected**: pm 第二次使用更新后的协作规范（即时生效，不是快照）

---

## 6. 导航与信息架构 (§4)

### T6.1: 左侧导航模块切换
**Category**: Happy Path | **Priority**: P0
**Steps**: 依次点击 Chat Rooms → Agents → Skills → Teams → Knowledge
**Expected**: 右侧主区域切换为对应管理界面

### T6.2: Room 创建流程升级 — 选 Team
**Category**: Happy Path | **Priority**: P0
**Steps**: 创建 room → 选 Team → 确认成员自动填充 → 选知识库 → 创建
**Expected**: room 创建成功，成员 = team 成员，关联知识库

### T6.3: Room 创建流程 — 不选 Team
**Category**: Boundary | **Priority**: P1
**Steps**: 创建 room → 不选 team → 手动勾选 agent
**Expected**: 正常创建（向下兼容 v1 流程）

---

## 7. openteam 模板迁移

### T7.1: Agent 模板完整性
**Category**: Happy Path | **Priority**: P1
**Steps**: 使用每个预置 agent 模板（PM/Architect/Developer/QA/Designer）创建 agent
**Expected**: 5 个模板全部可用，内容完整

### T7.2: Skill 模板完整性
**Category**: Happy Path | **Priority**: P1
**Steps**: 使用每个预置 skill 模板创建 skill
**Expected**: 12 个模板全部可用，内容完整

### T7.3: dev-team 模板完整性
**Category**: Happy Path | **Priority**: P1
**Steps**: 使用 dev-team 模板创建 team
**Expected**: 成员列表 + coordinated workflow + direct tasking + 角色分工表完整

---

## 8. 回归 — v1 功能不受影响

### T8.1: 群聊消息收发
**Category**: Regression | **Priority**: P0
**Steps**: 在 room 中发消息 + @agent
**Expected**: v1 所有群聊功能正常

### T8.2: 私聊 + steer
**Category**: Regression | **Priority**: P0
**Steps**: 打开私聊 tab → 发 steer → 切换 tab → 切回
**Expected**: 私聊事件保留，steer 正常工作

### T8.3: 归档
**Category**: Regression | **Priority**: P1
**Steps**: 触发归档 → 查询历史
**Expected**: 归档功能正常

### T8.4: 动态添加成员
**Category**: Regression | **Priority**: P1
**Steps**: + Member → 添加 agent
**Expected**: AddMemberDialog 正常工作

### T8.5: Rename / Delete Room
**Category**: Regression | **Priority**: P1
**Steps**: Rename + Delete room
**Expected**: UI-27/28 功能正常

---

## Test Strategy

### 测试分层

根据架构，测试分三层：

1. **API 层测试**（主要手段）
   - CRUD 路由：`GET/POST/PUT/DELETE /api/agents`, `/api/skills`, `/api/teams`, `/api/knowledge`
   - 直接 HTTP 请求验证业务逻辑，不依赖前端 UI
   - 验证文件系统同步：API 操作后检查 `~/.bossmode/` 文件内容

2. **System Prompt 组装验证**
   - 通过 API 创建完整场景（agent + skill + team + knowledge + room）
   - @agent 后检查 agent 行为是否体现五层内容
   - Mock pi-mono 验证 prompt 传入内容（或直接检查 API 暴露的 debug 端点）

3. **E2E 浏览器测试**（Playwright）
   - 导航切换、创建向导、模板选择
   - Markdown 编辑器交互
   - Room 创建流程（选 Team → 自动填充成员）

### 关键架构验证点

- **引用断裂降级**：skill 被删但 agent 还引用 → 静默忽略，不报错
- **即时生效**：team prompt 修改 → room 中 @agent 读到最新内容（Room 存引用不存快照）
- **文件系统双向同步**：Web UI 编辑 ↔ `~/.bossmode/` 文件
- **首次启动模板复制**：`templates/` → `~/.bossmode/agents/` + `skills/` + `teams/`（仅 agents/ 为空时）

### REST API 端点

```
# Agent: GET/POST /api/agents, GET/PUT/DELETE /api/agents/:name, GET /api/agents/templates
# Skill: GET/POST /api/skills, GET/PUT/DELETE /api/skills/:name, GET /api/skills/templates
# Team:  GET/POST /api/teams, GET/PUT/DELETE /api/teams/:name, GET /api/teams/templates
# Knowledge: GET/POST /api/knowledge, GET/DELETE /api/knowledge/:id
#   Entries: GET/POST /api/knowledge/:id/entries, PUT/DELETE /api/knowledge/:id/entries/:eid
# Room 创建扩展: POST /api/rooms body 新增 teamName? + knowledgeBaseId?
```

## Test Environment

- Node.js 18+
- Vitest + Playwright
- `~/.bossmode/` 测试隔离（BOSSMODE_DIR 环境变量）
- Agent/Skill/Team/Knowledge 的 fixture 文件
- 模板目录：`templates/agents/`, `templates/skills/`, `templates/teams/`

## PM 已确认参数

1. **Skill 删除**：提示"被 N 个 agent 引用，确认删除？"确认后自动解绑
2. **知识库大小**：v2 不设上限，先不做边界测试，记录实际 token 消耗作为基线
3. **Team Prompt 更新**：即时生效 — 每次激活动态读取最新 team prompt
4. **Agent 名称**：英文字母 + 数字 + 连字符，不支持中文/空格
5. **协作规范版本管理**：已关闭 — 即时生效
