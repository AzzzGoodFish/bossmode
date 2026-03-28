# Test Plan: Bossmode

**PRD**: `docs/prd-bossmode.md`
**Architecture**: `/home/fish/dev/llm/bossmode/docs/architecture.md`
**Repo**: `/home/fish/dev/llm/bossmode/`
**Author**: QA
**Status**: Ready — 架构已出，测试实现方式已细化

---

## Coverage Summary

- Total test cases: 53
- P0 (critical): 29
- P1 (important): 17
- P2 (nice-to-have): 7

## Test Strategy

### 测试分层

根据架构，测试分三层执行：

1. **API 层测试**（主要手段）
   - REST API: `POST /api/auth/login`, `POST /api/rooms`, `POST /api/rooms/:id/messages` 等
   - 直接 HTTP 请求验证业务逻辑，不依赖前端 UI
   - 适用：F1-F8, F12-F17, F19-F21 的核心逻辑验证

2. **WebSocket 事件验证**
   - 连接 WebSocket，subscribe room/agent channel
   - 验证事件：`room:message`（消息推送）、`agent:status`（状态变更）、`agent:event`（私聊流）
   - 适用：NF3 实时性、F5/F9/F10 的实时推送

3. **E2E 浏览器测试**（Playwright）
   - 登录流程、UI 交互、多标签同步
   - 适用：F2 登录、T3.11 多标签推送、端到端场景

### 测试框架

- **Vitest** — 与 Vite 生态对齐，TypeScript 原生支持
- **Playwright** — E2E 浏览器测试
- **ws** — WebSocket 客户端（API 层测试用）

### 数据模型验证

根据架构的持久化方案，关键文件验证点：
- `~/.bossmode/config.json` — 认证凭据、API Key
- `~/.bossmode/bossmode.pid` — 进程 PID
- `~/.bossmode/agents/*.md` — agent 定义（frontmatter: name, model, description）
- `~/.bossmode/rooms/<roomId>/room.json` — room 配置（id, name, cwd, members）
- `~/.bossmode/rooms/<roomId>/messages.jsonl` — 消息（JSONL 追加）
- `~/.bossmode/rooms/<roomId>/cursors.json` — 每个 agent 的 last seen cursor
- `~/.bossmode/rooms/<roomId>/archives/` — 归档文件

### Activation Flow 验证要点

架构明确了两条路径（测试核心）：
- **空闲 agent**: `AgentManager.activate()` → `agent.prompt(incrementalMessages)` → status → "working"
- **工作中 agent**: `AgentManager.activate()` → `agent.steer(incrementalMessages)` → status 保持 "working"

两条路径都更新 `lastSeenCursor`，通过 `cursors.json` 可直接验证。

### PM 确认的测试参数

- **T10.3 多 session**：允许多 session 并存，不互踢（和 Discord 一样）
- **T7.4 摘要质量**：必须保留所有发言 agent 名称 + 主要决策 + 行动项
- **归档保留条数**：50 条

---

## 1. 启动与认证 (F1, F2, F21, NF1, NF2)

### T1.1: CLI 正常启动
**Category**: Happy Path | **Priority**: P0 | **Req**: F1, NF1
**Preconditions**: 无 bossmode 实例运行
**Steps**:
1. 执行 `bossmode on --port 1234`
2. 观察终端输出
**Expected**: 输出包含访问地址 `http://....:1234`，进程常驻后台（命令立即返回），PID 文件写入
**Verify**:
- `~/.bossmode/bossmode.pid` 存在且内容为有效 PID
- `curl http://127.0.0.1:1234` 返回前端页面（静态文件 serving）
- `ps -p <pid>` 进程存在

### T1.2: 指定 host 启动（局域网访问）
**Category**: Happy Path | **Priority**: P0 | **Req**: F1, NF2
**Steps**:
1. 执行 `bossmode on --host 0.0.0.0 --port 1234`
2. 从同一局域网的另一设备访问 `http://<server-ip>:1234`
**Expected**: 能正常访问登录页

### T1.3: 端口被占用
**Category**: Error | **Priority**: P0 | **Req**: F1
**Preconditions**: 端口 1234 已被其他进程占用
**Steps**:
1. 执行 `bossmode on --port 1234`
**Expected**: 报错提示端口被占用，进程不会常驻

### T1.4: 重复启动幂等
**Category**: Boundary | **Priority**: P0 | **Req**: F1
**Preconditions**: bossmode 已在端口 1234 运行
**Steps**:
1. 再次执行 `bossmode on --port 1234`
**Expected**: 提示已有实例运行，输出现有实例的访问地址，不启动新进程

### T1.5: 正常登录
**Category**: Happy Path | **Priority**: P0 | **Req**: F2
**Steps**:
1. 浏览器访问 bossmode 地址
2. 输入正确用户名密码
**Expected**: 进入主界面，看到群聊列表和联系人列表

### T1.6: 错误凭据登录
**Category**: Error | **Priority**: P0 | **Req**: F2
**Steps**:
1. 浏览器访问 bossmode 地址
2. 输入错误密码
**Expected**: 显示认证失败提示，停留在登录页

### T1.7: 未登录访问主界面
**Category**: Error | **Priority**: P1 | **Req**: F2
**Steps**:
1. 浏览器直接访问主界面 URL（未登录）
**Expected**: 重定向到登录页

### T1.8: API Key 缺失提示
**Category**: Error | **Priority**: P0 | **Req**: F21
**Preconditions**: 环境变量和配置文件均无 API Key
**Steps**:
1. 执行 `bossmode on`
**Expected**: 提示用户配置 API Key，说明支持的环境变量名

### T1.9: API Key 优先级
**Category**: Boundary | **Priority**: P1 | **Req**: F21
**Preconditions**: 环境变量设置 `ANTHROPIC_API_KEY=env-key`，配置文件设置不同的 key
**Steps**:
1. 启动 bossmode，激活 agent 执行任务
**Expected**: 使用环境变量中的 key（优先于配置文件）

### T1.10: 首次启动交互式设置认证凭据
**Category**: Happy Path | **Priority**: P1 | **Req**: F2（Resolved Decisions）
**Preconditions**: `~/.bossmode/config.json` 不存在
**Steps**:
1. 首次执行 `bossmode on`
**Expected**: 交互式提示设置用户名密码，保存到 `~/.bossmode/config.json`

---

## 2. 联系人与群聊管理 (F3, F4, F16, F17, F18)

### T2.1: 联系人列表展示
**Category**: Happy Path | **Priority**: P0 | **Req**: F3
**Preconditions**: `~/.bossmode/agents/` 下有 pm.md, architect.md, developer.md
**Steps**:
1. 登录后查看联系人列表
**Expected**: 显示 pm、architect、developer，各自显示状态（空闲）

### T2.2: 联系人状态实时更新
**Category**: Happy Path | **Priority**: P1 | **Req**: F3, NF3
**Steps**:
1. 在群聊中 @pm 下达指令
2. 观察联系人列表中 pm 的状态
**Expected**: pm 状态实时变为"工作中"；完成后回到"空闲"

### T2.3: 创建群聊 — 正常流程
**Category**: Happy Path | **Priority**: P0 | **Req**: F4
**Steps**:
1. 点击"创建群聊"
2. 选择工作目录 `/home/fish/dev/some-project`
3. 勾选 pm、architect、developer
4. 确认创建
**Expected**: 群聊创建成功，进入群聊界面，成员面板显示三个 agent

### T2.4: 创建群聊 — 无效工作目录
**Category**: Error | **Priority**: P1 | **Req**: F4
**Steps**:
1. 创建群聊时选择不存在的目录
**Expected**: 提示目录不存在或无权限

### T2.5: 创建群聊 — 不勾选 agent
**Category**: Boundary | **Priority**: P2 | **Req**: F4
**Steps**:
1. 创建群聊时不勾选任何 agent
**Expected**: 允许创建（用户可以之后添加成员）

### T2.6: 动态添加群聊成员
**Category**: Happy Path | **Priority**: P1 | **Req**: F16
**Preconditions**: 群聊已有消息（M1-M5），qa 不在成员中
**Steps**:
1. `POST /api/rooms/:id/members` body: `{ agent: "qa" }`
2. 读取 `room.json` 和 `cursors.json`
**Expected**:
- `room.json` 的 members 包含 qa
- `cursors.json` 中 qa 的 cursor = 加入时最新消息 ID（M5）
- 首次 `@qa` 激活时，qa 不会收到 M1-M5（加入前的历史消息）
- WebSocket 推送成员变更事件

### T2.7: 群聊列表展示
**Category**: Happy Path | **Priority**: P1 | **Req**: F17
**Preconditions**: 已创建多个群聊
**Steps**:
1. 查看群聊列表
**Expected**: 显示所有群聊，包含工作目录信息，点击可进入继续对话

### T2.8: 多群聊共享目录
**Category**: Boundary | **Priority**: P2 | **Req**: F4（Resolved Decisions）
**Steps**:
1. 创建两个群聊，工作目录相同
**Expected**: 两个群聊独立存在，互不干扰

---

## 3. 群聊消息与 @ 激活 (F5, F6, F7, F8, F12, F13) ⭐ 重点测试区域

### T3.1: 用户发送群聊消息
**Category**: Happy Path | **Priority**: P0 | **Req**: F5
**Steps**:
1. 在群聊输入框输入普通文本，发送
**Expected**: 消息实时出现在消息区域

### T3.2: @ 激活空闲 agent
**Category**: Happy Path | **Priority**: P0 | **Req**: F6
**Preconditions**: pm 处于空闲状态
**Steps**:
1. `POST /api/rooms/:id/messages` body: `{ content: "@pm 分析一下这个项目的 README" }`
2. 监听 WebSocket `room:message` 和 `agent:status` 事件
**Expected**:
- 收到 `room:message` 事件（用户消息）
- 收到 `agent:status` 事件：`{ agent: "pm", status: "working" }`
- `cursors.json` 中 pm 的 cursor 更新到最新消息 ID
- pm 通过 `agent.prompt()` 路径激活（非 steer）

### T3.3: @ 正在工作中的 agent（steer 注入）⭐
**Category**: Happy Path | **Priority**: P0 | **Req**: F6, F13
**Preconditions**: pm 正在工作中（已被激活且未完成）
**Steps**:
1. `POST /api/rooms/:id/messages` body: `{ content: "@pm 改一下方向，重点关注性能" }`
2. 监听 WebSocket 事件
**Expected**:
- 收到 `room:message` 事件（消息出现在群聊）
- **不**收到新的 `agent:status` → "working" 事件（pm 已经 working）
- pm 通过 `agent.steer()` 路径注入（非 prompt）
- `cursors.json` 中 pm 的 cursor 更新
- 监听 `agent:event`（私聊流），后续 LLM 响应体现新指令

### T3.4: @ 不在群聊中的 agent
**Category**: Error | **Priority**: P0 | **Req**: F6
**Preconditions**: qa 不在当前群聊成员中
**Steps**:
1. 输入 `@qa 跑一下测试`
**Expected**: 提示 qa 不是群聊成员

### T3.5: Agent 群聊发言
**Category**: Happy Path | **Priority**: P0 | **Req**: F7
**Preconditions**: pm 被 @ 激活并在工作中
**Steps**:
1. 等待 pm 调用群聊发言工具
**Expected**: pm 的发言实时出现在群聊消息区域，消息带有发言者标识

### T3.6: Agent 间 @ 激活
**Category**: Happy Path | **Priority**: P0 | **Req**: F8
**Preconditions**: pm 在工作中
**Steps**:
1. pm 在群聊发言后，使用 @ 工具激活 architect
**Expected**:
- architect 被激活
- architect 收到自己 last seen cursor 之后的所有群聊消息（包含 pm 的发言）
- architect 状态变为"工作中"

### T3.7: Agent @ 正在工作中的 agent
**Category**: Boundary | **Priority**: P0 | **Req**: F8, F13
**Preconditions**: architect 正在工作中
**Steps**:
1. pm 使用 @ 工具激活 architect
**Expected**: 走 steer 注入，不重新激活（同 T3.3 逻辑）

### T3.8: @all 广播激活 ⭐
**Category**: Happy Path | **Priority**: P0 | **Req**: F12
**Preconditions**: 群聊中有 pm、architect、developer，全部空闲
**Steps**:
1. 先发几条不带 @ 的消息（M1, M2），各 agent cursor 不同
2. `POST /api/rooms/:id/messages` body: `{ content: "@all 开始工作，各自分析项目结构" }`
3. 监听 WebSocket 事件
**Expected**:
- 收到 3 个 `agent:status` 事件，每个 agent → "working"
- 每个 agent 通过 `agent.prompt()` 激活（全部空闲）
- `cursors.json` 中每个 agent 的 cursor 各自更新到最新
- 关键验证：pm/architect/developer 收到的增量消息数量可能不同（取决于各自之前的 cursor 位置）

### T3.9: @all 时部分 agent 在工作中
**Category**: Boundary | **Priority**: P0 | **Req**: F12, F13
**Preconditions**: pm 在工作中，architect 和 developer 空闲
**Steps**:
1. 输入 `@all 同步一下进度`
**Expected**:
- architect、developer 被激活（空闲 → 工作中）
- pm 走 steer 注入（已在工作中）

### T3.10: 增量消息 — last seen cursor 正确性 ⭐
**Category**: Integration | **Priority**: P0 | **Req**: F6, F12
**Steps**:
1. `POST /api/rooms/:id/messages` 发 3 条普通消息（M1, M2, M3）
2. `POST /api/rooms/:id/messages` body: `{ content: "@pm 任务A" }`
3. 读取 `cursors.json`，记录 pm cursor 值（应为 @pm 消息的 ID）
4. pm 工作中，继续 POST 2 条普通消息（M4, M5）
5. 等待 pm 完成（`agent:status` → "idle"）
6. POST 1 条普通消息（M6）
7. `POST /api/rooms/:id/messages` body: `{ content: "@pm 任务B" }`
8. 读取 `cursors.json`，确认 pm cursor 更新
**Expected**:
- 步骤 3：pm cursor = 步骤 2 的消息 ID
- 步骤 7：pm 收到 M4, M5, M6 + "@pm 任务B"（4 条增量）
- 步骤 8：pm cursor = 步骤 7 的消息 ID
- 验证：`messages.jsonl` 中的消息序列完整

### T3.11: 消息实时推送
**Category**: Happy Path | **Priority**: P0 | **Req**: F5, NF3
**Steps**:
1. 在群聊中打开两个浏览器标签
2. 在一个标签发送消息
**Expected**: 另一个标签实时看到消息（WebSocket 推送，无需刷新）

### T3.12: Agent 完成后状态回归
**Category**: Happy Path | **Priority**: P0 | **Req**: F6, F9
**Steps**:
1. @pm 下达简单任务
2. 等待 pm 完成
**Expected**: pm 状态从"工作中"回到"空闲"，成员面板实时更新

---

## 4. 私聊窗口 (F10, F11) ⭐ 重点测试区域

### T4.1: 查看 agent 工作过程
**Category**: Happy Path | **Priority**: P0 | **Req**: F10
**Preconditions**: pm 正在工作中
**Steps**:
1. 点击成员面板中的 pm 打开私聊
**Expected**: 看到工具调用、思考过程的实时流（不是等完成后才显示）

### T4.2: 私聊追加指令（steer）
**Category**: Happy Path | **Priority**: P0 | **Req**: F11
**Preconditions**: pm 正在工作中，已打开私聊窗口
**Steps**:
1. 在私聊输入框输入 `不用看 README 了，直接看 src/ 目录结构`
2. 发送
**Expected**:
- 指令注入 pm 上下文
- pm 后续行为调整
- **该指令不出现在群聊消息区域**

### T4.3: 私聊指令不同步到群聊 ⭐
**Category**: Integration | **Priority**: P0 | **Req**: F11
**Steps**:
1. 通过私聊 API 给 pm 发送指令（steer 路径）
2. `GET /api/rooms/:id/messages` 获取群聊消息列表
3. 读取 `messages.jsonl` 文件
**Expected**:
- REST API 返回的消息列表中无私聊指令
- `messages.jsonl` 中无私聊指令记录
- WebSocket `room:message` 事件未触发

### T4.4: 对空闲 agent 发私聊消息
**Category**: Boundary | **Priority**: P1 | **Req**: F11
**Preconditions**: pm 处于空闲状态
**Steps**:
1. 打开 pm 私聊窗口
2. 发送指令
**Expected**: pm 被激活，开始执行任务（相当于单独给 agent 布置任务）

### T4.5: 私聊窗口实时流
**Category**: Happy Path | **Priority**: P1 | **Req**: F10, NF3
**Preconditions**: pm 被激活
**Steps**:
1. 打开 pm 私聊窗口
2. 观察工具调用过程
**Expected**: 工具调用、思考过程实时流式展示，不等待完成

---

## 5. 成员面板与状态 (F9, F20)

### T5.1: 成员面板展示
**Category**: Happy Path | **Priority**: P0 | **Req**: F9
**Preconditions**: 群聊中有 pm、architect、developer
**Steps**:
1. 查看成员面板
**Expected**: 显示所有成员，当前状态（空闲/工作中）

### T5.2: 状态实时变更
**Category**: Happy Path | **Priority**: P0 | **Req**: F9, NF3
**Steps**:
1. @pm 下达指令
2. 观察成员面板
**Expected**: pm 状态实时从"空闲"变为"工作中"，完成后回到"空闲"

### T5.3: 模型配置生效
**Category**: Happy Path | **Priority**: P1 | **Req**: F20
**Preconditions**: agent 定义文件中 pm 指定 model 为 `claude-sonnet-4-6`
**Steps**:
1. @pm 下达任务
**Expected**: pm 使用 claude-sonnet-4-6 模型执行（可通过日志或私聊窗口验证）

---

## 6. 错误处理 (F19) ⭐ 重点测试区域

### T6.1: Agent 工作中出错 — 群聊显示错误摘要
**Category**: Error | **Priority**: P0 | **Req**: F19
**Preconditions**: agent 执行的任务会触发错误
**Steps**:
1. `POST /api/rooms/:id/messages` body: `{ content: "@pm 读取 /nonexistent/path/file.txt 的内容" }`
2. 监听 WebSocket 事件
**Expected**:
- 收到 `room:message` 事件，sender 为系统或 pm，内容为错误摘要（简洁）
- 收到 `agent:status` 事件：`{ agent: "pm", status: "idle" }`
- 收到 `agent:event` 事件（私聊通道），包含完整错误栈
- `messages.jsonl` 中记录错误摘要消息
- 不触发后续的 `agent:status` → "working"（不自动重试）

### T6.2: Agent 出错后可重新激活
**Category**: Error | **Priority**: P0 | **Req**: F19
**Preconditions**: pm 刚因错误回到 idle
**Steps**:
1. @pm 下达新任务
**Expected**: pm 正常被激活，可以正常工作

### T6.3: Agent 出错不影响其他 agent
**Category**: Integration | **Priority**: P1 | **Req**: F19
**Preconditions**: pm 和 architect 都在工作中
**Steps**:
1. pm 遇到错误
**Expected**: pm 回到 idle 并显示错误，architect 不受影响继续工作

### T6.4: 多个 agent 同时出错
**Category**: Boundary | **Priority**: P2 | **Req**: F19
**Steps**:
1. @all 下达一个所有 agent 都会失败的任务
**Expected**: 每个 agent 各自报错，各自回到 idle，群聊显示每个 agent 的错误摘要

---

## 7. 归档与历史 (F14, F15) ⭐ 重点测试区域

### T7.1: 手动触发归档
**Category**: Happy Path | **Priority**: P1 | **Req**: F14
**Preconditions**: 群聊中有 60+ 条消息
**Steps**:
1. `POST /api/rooms/:id/archive`
2. 检查文件系统和 API 响应
**Expected**:
- `archives/<timestamp>.jsonl` 包含被归档的原始消息
- `archives/<timestamp>.summary.json` 包含摘要（Haiku 生成）
- `messages.jsonl` 只保留最近 50 条 + 摘要消息
- `GET /api/rooms/:id/messages` 返回摘要 + 最近 50 条
- 摘要内容包含所有发言过的 agent 名称和主要决策

### T7.2: 归档后查询历史
**Category**: Happy Path | **Priority**: P1 | **Req**: F15
**Preconditions**: 已执行归档
**Steps**:
1. 使用历史查询功能
**Expected**: 能检索并查看归档前的原始消息

### T7.3: 归档后 agent 激活的增量消息
**Category**: Integration | **Priority**: P1 | **Req**: F14, F6
**Preconditions**: 归档刚完成
**Steps**:
1. @pm 下达任务
**Expected**: pm 收到的增量消息包含摘要（如果归档后无新消息则只收到本次指令 + 摘要上下文），不包含被归档的原始消息

### T7.4: 摘要质量验证
**Category**: Boundary | **Priority**: P2 | **Req**: F14
**Steps**:
1. 在群聊中进行一段有意义的技术讨论
2. 触发归档
**Expected**: 摘要保留关键信息（决策、结论），而非流水账

---

## 8. 进程管理

### T8.1: bossmode off 正常停止（所有 agent 空闲）
**Category**: Happy Path | **Priority**: P0 | **Req**: F1
**Preconditions**: bossmode 正在运行，所有 agent 空闲
**Steps**:
1. 执行 `bossmode off`
**Expected**:
- 进程优雅停止
- `~/.bossmode/bossmode.pid` 已删除
- 端口释放（`curl` 连接拒绝）
- WebSocket 连接关闭

### T8.1b: bossmode off 有 agent 在工作中
**Category**: Boundary | **Priority**: P0 | **Req**: F1
**Preconditions**: bossmode 运行中，pm 正在工作
**Steps**:
1. 执行 `bossmode off`
**Expected**:
- 先等待 pm idle（最多 5s）
- 超时后 force terminate
- PID 文件清理，端口释放
- 进程最终退出（不会无限等待）

### T8.2: bossmode off 无实例运行
**Category**: Boundary | **Priority**: P2 | **Req**: F1
**Steps**:
1. 无 bossmode 实例运行时执行 `bossmode off`
**Expected**: 提示无运行中的实例

---

## 9. 端到端场景 (Scenario 覆盖)

### T9.1: 完整工作流 — 从启动到 agent 协作（Scenario 1-5 综合）
**Category**: Integration | **Priority**: P0 | **Req**: 全局
**Steps**:
1. `bossmode on --port 1234`
2. 浏览器登录
3. 创建群聊，选择工作目录，勾选 pm + architect
4. `@pm 分析项目 README 梳理核心功能`
5. 等待 pm 在群聊发言汇报分析结果
6. pm 在群聊中 @ architect，传递结论
7. architect 被激活，开始设计
8. 期间用户打开 architect 私聊查看工作过程
9. 用户在私聊中追加约束指令
10. architect 完成，在群聊汇报
**Expected**: 全流程顺畅，消息实时推送，状态正确流转，私聊指令不泄露到群聊

### T9.2: 动态拉人场景（Scenario 7）
**Category**: Integration | **Priority**: P1 | **Req**: F16
**Steps**:
1. 群聊只有 pm、architect
2. 工作进行中，添加 developer 到群聊
3. @developer 基于之前讨论分配任务
**Expected**: developer 加入后可被 @，收到 last seen cursor 后的增量消息

### T9.3: 归档后继续工作（Scenario 6）
**Category**: Integration | **Priority**: P1 | **Req**: F14, F15
**Steps**:
1. 群聊中进行大量对话
2. 触发归档
3. 继续在群聊中 @ agent 工作
**Expected**: 归档后群聊显示摘要，新指令正常工作，agent 能利用摘要上下文

---

## 10. 非功能需求

### T10.1: 无外部依赖启动
**Category**: Happy Path | **Priority**: P0 | **Req**: NF1
**Preconditions**: 干净环境，无 Redis/数据库
**Steps**:
1. 只安装 bossmode 本身
2. `bossmode on`
**Expected**: 正常启动，不报缺少外部服务

### T10.2: 数据持久化
**Category**: Happy Path | **Priority**: P1 | **Req**: NF4
**Steps**:
1. 创建群聊，发送消息
2. `bossmode off`
3. `bossmode on`
4. 打开同一群聊
**Expected**: 聊天记录和群聊配置恢复

### T10.3: 多 session 并存
**Category**: Boundary | **Priority**: P2 | **Req**: NF5
**Steps**:
1. 两个浏览器标签同时登录
2. 在标签 A 发送群聊消息
3. 在标签 B 观察
**Expected**:
- 两个标签都能正常使用，不互踢
- 标签 B 实时收到标签 A 的消息（WebSocket `room:message`）
- 状态变更同步推送到两个标签

---

## Test Environment Requirements

- Node.js 18+
- TypeScript（项目语言）
- pi-mono 库（`~/dev/agents/pi-mono/`，agent 执行引擎）
- 浏览器：Chrome（Playwright 驱动）
- 测试框架：Vitest + Playwright
- WebSocket 客户端：`ws` 包
- agent 定义文件：至少 2 个（`~/.bossmode/agents/pm.md`, `architect.md`）
- 有效的 API Key（真实 LLM 调用）
- 可选：局域网内第二台设备（T1.2 测试）

## Test Data Setup

每次测试前的 fixture 准备：
```bash
# 清理测试环境
rm -rf ~/.bossmode/rooms/test-*
# 确保 agent 定义存在
cp fixtures/agents/*.md ~/.bossmode/agents/
# 确保 config 存在（含测试用凭据）
cp fixtures/config.json ~/.bossmode/config.json
```

## Risks & Notes

1. **pi-mono 依赖**：agent 执行完全依赖 pi-mono，若 pi-mono API 不稳定会影响大量测试。建议 Phase 1-2 测试中 mock agent 行为，Phase 3+ 用真实 pi-mono
2. **真实 LLM 调用成本**：P0 测试涉及真实 agent 执行，需要实际 API 调用，建议用简单任务（如"列出当前目录文件"）降低 token 消耗
3. **steer 时机不确定性**：F13 的"下次 LLM 调用时生效"依赖 pi-mono 的 steer 实现，测试时验证 steer 被调用即可，不验证精确生效时机
4. **归档摘要质量**：PM 已确认标准 — 必须包含所有发言 agent 名称 + 主要决策 + 行动项
5. **优雅关闭超时**：T8.1b 需要能触发 agent 长时间工作的场景来验证 5s 超时 force terminate
