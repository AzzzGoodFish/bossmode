# Agent Runtime Abstraction Layer

**Author**: Architect
**Status**: Draft
**Date**: 2026-03-20

---

## 1. 动机

Bossmode 当前硬绑定 pi-mono 作为 agent 引擎。未来可能接入其他引擎（如 Claude Code CLI SDK 模式、OpenAI Agents SDK 等）。需要一个抽象层将 bossmode 的业务逻辑与具体 agent 引擎解耦。

设计原则（来自 fish）：
- 定义最小必须能力 — 不满足则无法接入
- 基于能力声明做优雅降级 — 可选能力缺失时 UI 隐藏对应功能

## 2. 最小必须能力（Minimum Required）

以下能力是接入 bossmode 的硬性条件。缺任何一个，该 runtime 无法使用：

| 能力 | 说明 | 为什么必须 |
|------|------|-----------|
| 创建 agent | 给定 system prompt + cwd + model 创建实例 | 没有实例就没有一切 |
| prompt | 发送消息启动 agent 工作 | @ 激活的基础 |
| steer | 工作中注入消息 | 群聊 @正在工作的 agent、私聊 steer 指令 |
| 状态查询 | 知道 agent 是否在工作 | 决定 prompt vs steer、状态面板展示 |
| 事件订阅 | 至少 agent_start + agent_end | 状态广播、私聊窗口 |
| abort | 终止正在工作的 agent | graceful shutdown |
| 自定义工具 | 注册 chat + mention 工具 | agent 参与群聊的唯一方式 |

## 3. 可选能力（Optional — 优雅降级）

| 能力 ID | 说明 | 有 → 功能 | 无 → 降级 |
|---------|------|----------|----------|
| `streaming` | 流式文本事件 (message_update) | 私聊打字机效果 | 私聊只显示最终结果 |
| `toolEvents` | 工具调用事件 (tool_start/end) | 私聊工具调用卡片 | 私聊不显示工具过程 |
| `thinking` | 思考过程内容 | 私聊思考折叠卡片 | 不显示思考 |
| `usage` | token 用量和费用 | 显示 cost | 不显示 |
| `dynamicModel` | 运行时切换模型 | UI 模型选择器 | 模型选择器禁用 |
| `dynamicPrompt` | 运行时修改 system prompt | UI prompt 编辑 | prompt 编辑禁用 |
| `thinkingLevel` | 控制思考深度 | UI thinking 滑块 | 隐藏 |

## 4. 接口设计

```typescript
// src/core/runtime/types.ts

// ── 能力声明 ──

type RuntimeCapability =
  | "streaming"
  | "toolEvents"
  | "thinking"
  | "usage"
  | "dynamicModel"
  | "dynamicPrompt"
  | "thinkingLevel";

// ── Runtime 工厂 ──

interface AgentRuntime {
  readonly name: string;                          // "pi-mono", "claude-cli", etc.
  readonly capabilities: Set<RuntimeCapability>;

  createAgent(opts: CreateAgentOpts): Promise<AgentHandle>;
  shutdownAll(): Promise<void>;
}

// ── 创建参数 ──

interface CreateAgentOpts {
  cwd: string;
  systemPrompt: string;
  model: string;               // runtime 自行解析（pi-mono 用 getModel，CLI 用 --model 参数）
  agentName: string;
  roomMembers: string[];       // mention 工具需要知道有谁
  callbacks: AgentCallbacks;
}

interface AgentCallbacks {
  onChat: (message: string) => Promise<void>;
  onMention: (target: string, message: string) => Promise<void>;
  getApiKey: (provider: string) => Promise<string | undefined>;
}

// ── Agent 操作句柄 ──

interface AgentHandle {
  prompt(message: string): Promise<void>;
  steer(message: string): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;
  readonly isWorking: boolean;

  // 可选操作 — 调用前通过 runtime.capabilities 检查
  setModel?(model: string): void;
  setSystemPrompt?(prompt: string): void;
  setThinkingLevel?(level: string): void;
}

// ── 统一事件模型 ──

type AgentStreamEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "message_start" }
  | { type: "message_update"; text?: string; thinking?: string }
  | { type: "message_end"; text: string; usage?: TokenUsage }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | { type: "tool_update"; toolName: string; toolCallId: string; partialResult: unknown }
  | { type: "tool_end"; toolName: string; toolCallId: string; result: unknown; isError: boolean };

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost?: number;
}
```

## 5. 实现文件结构

```
src/core/runtime/
├── types.ts              ← 上面的接口定义
├── pi-mono.ts            ← PiMonoRuntime implements AgentRuntime
└── (claude-cli.ts)       ← 未来：ClaudeCliRuntime implements AgentRuntime
```

## 6. 各层职责变化

### runtime 层（新增）
- 封装具体 agent 引擎的 API
- 将引擎原生事件映射为 AgentStreamEvent
- 处理自定义工具注册（pi-mono: AgentTool 注入；CLI: MCP server）
- 声明自身能力集

### agent-manager（修改）
- 不再直接引用 pi-mono
- 通过 AgentRuntime.createAgent() 获取 AgentHandle
- 实例生命周期、cursor 跟踪、状态广播不变
- 启动时接收 runtime 实例（依赖注入）

### 前端（小改）
- 通过 GET /api/capabilities 获取当前 runtime 的能力集
- **UI 原则：不可用的功能隐藏，不灰色禁用。** 用户不需要知道底层引擎的能力边界，只看到当前能用的功能，保持界面干净。
  - `dynamicModel` 不可用 → 隐藏模型选择器
  - `thinking` 不可用 → 私聊不渲染思考卡片
  - `usage` 不可用 → 不显示 token/费用信息
  - 其他能力同理
- PrivateChat 组件根据能力集决定渲染哪些事件类型

## 7. pi-mono 事件映射

| pi-mono AgentEvent | → AgentStreamEvent |
|---|---|
| `agent_start` | `agent_start` |
| `agent_end` | `agent_end` |
| `message_start` | `message_start` |
| `message_update` (role=assistant) | `message_update` — 提取 text content 和 thinking content |
| `message_end` (role=assistant) | `message_end` — 提取 text, 附加 usage |
| `turn_start` / `turn_end` | 不映射（turn 粒度是 pi-mono 特有的，业务层不需要） |
| `tool_execution_start` | `tool_start` |
| `tool_execution_update` | `tool_update` |
| `tool_execution_end` | `tool_end` |

pi-mono runtime 的能力声明：
```typescript
capabilities: new Set([
  "streaming",
  "toolEvents",
  "thinking",       // 取决于模型
  "usage",
  "dynamicModel",
  "dynamicPrompt",
  "thinkingLevel",
])
```

## 8. 改动范围

| 操作 | 文件 | 说明 |
|------|------|------|
| 新增 | `src/core/runtime/types.ts` | 接口定义 |
| 新增 | `src/core/runtime/pi-mono.ts` | pi-mono 实现，从 agent-manager.ts 和 tools.ts 搬入 pi-mono 相关代码 |
| 修改 | `src/core/agent-manager.ts` | 从直接用 Agent 改为用 AgentHandle，构造时接收 runtime |
| 修改 | `src/server/index.ts` | 启动时创建 runtime 实例，注入 agent-manager |
| 修改 | `src/server/api.ts` | 新增 GET /api/capabilities endpoint |
| 删除 | `src/core/tools.ts` | 内容移入 `runtime/pi-mono.ts` |
| 小改 | `web/src/components/PrivateChat.tsx` | 适配 AgentStreamEvent 格式 |

## 9. 风险

| 风险 | 缓解 |
|------|------|
| 事件映射丢信息 | message_update 保留 text + thinking 两个字段；message_end 保留 usage |
| 抽象泄漏 | AgentHandle 的可选方法通过 capabilities 守卫，不会误调 |
| 重构引入 bug | agent-manager 的逻辑不变，只是调用方式变了；单测覆盖 |
