# Runtime V2 Architecture — CLI-Only Design

**Author**: Architect
**Status**: Draft
**Date**: 2026-03-24

---

## 1. 设计原则

Bossmode 是管理层和 UI 层，不嵌入任何 agent 引擎代码。所有 agent 通过 spawn 外部 CLI 进程运行。

两个 runtime：
- **pi-cli** — `pi --mode rpc` 双向 JSON 协议
- **claude-cli** — `claude --input-format stream-json --output-format stream-json` 双向 JSON 协议

## 2. 数据模型

### Member（成员配置）

```typescript
interface MemberConfig {
  id: string;
  name: string;                // 展示名，如 "architect"
  agentSource: string;         // agent 定义文件路径（~/.bossmode/agents/architect.md）
  model: string;               // "claude-sonnet-4-6", "openai/gpt-5"
  runtime: "pi-cli" | "claude-cli";
  skills: string[];            // skill 目录路径列表
  thinkingLevel: string;       // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
  avatar?: string;
}
```

存储：`~/.bossmode/members.json`

### Platform Runtime Config

```json
// ~/.bossmode/config.json
{
  "auth": { "username": "fish", "passwordHash": "..." },
  "defaults": { "host": "127.0.0.1", "port": 8080 },
  "runtimes": {
    "pi-cli": {
      "enabled": true,
      "cliPath": "/home/fish/.nvm/versions/node/v24.13.0/bin/pi"
    },
    "claude-cli": {
      "enabled": true,
      "cliPath": "/home/fish/.local/bin/claude"
    }
  }
}
```

## 3. Runtime 抽象接口

```typescript
// src/core/runtime/types.ts

interface AgentRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;

  detect(): Promise<RuntimeDetectResult>;
  createAgent(opts: CreateAgentOpts): Promise<AgentHandle>;
  shutdownAll(): Promise<void>;
}

interface RuntimeDetectResult {
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

interface RuntimeCapabilities {
  streaming: boolean;
  toolEvents: boolean;
  thinking: boolean;
  usage: boolean;
  dynamicModel: boolean;       // pi-cli: ✅ (set_model), claude-cli: ❌
  dynamicThinking: boolean;    // pi-cli: ✅ (set_thinking_level), claude-cli: ❌
  permissionControl: boolean;  // pi-cli: ❌, claude-cli: ✅
  sessionResume: boolean;
}

interface CreateAgentOpts {
  cwd: string;
  member: MemberConfig;

  // 分层传入 — runtime 自行决定传递方式
  agentPrompt: string;         // Layer 1: agent 定义 body
  skillPaths: string[];        // Layer 2: skill 目录路径（--skill 原生注册）
  teamPrompt?: string;         // Layer 3: 协作规范（--append-system-prompt）

  roomMembers: string[];       // 工具描述中列出可 mention 的成员
  callbacks: AgentCallbacks;
}

interface AgentCallbacks {
  onChat: (message: string) => Promise<void>;
  onMention: (target: string, message: string) => Promise<void>;
  onSaveKnowledge?: (title: string, content: string) => Promise<void>;
  onQueryKnowledge?: (query?: string) => Promise<KnowledgeEntry[]>;
}

interface AgentHandle {
  prompt(message: string): Promise<void>;
  steer(message: string): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  subscribe(fn: (event: AgentStreamEvent) => void): () => void;
  readonly isWorking: boolean;

  // 可选 — 通过 runtime.capabilities 检查
  setModel?(model: string): void;
  setThinkingLevel?(level: string): void;
}

// 统一事件模型
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
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}
```

## 4. Pi CLI Runtime 实现

### 进程启动

```typescript
const args = [
  "--mode", "rpc",
  "--system-prompt", opts.agentPrompt,
  "--model", opts.member.model,
  "--thinking", opts.member.thinkingLevel,
  "--no-session",
  "--extension", this.extensionPath,   // bossmode 自定义工具
  ...opts.skillPaths.flatMap(p => ["--skill", p]),
];

if (opts.teamPrompt) {
  args.push("--append-system-prompt", opts.teamPrompt);
}

const proc = spawn("pi", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
```

### 自定义工具 — Extension 文件

bossmode 生成一个 TypeScript extension 文件，注册 chat/mention/save_knowledge/query_knowledge 工具。工具通过 HTTP 回调 bossmode server 的内部端点。

```typescript
// 动态生成的 extension（每个 agent 实例一个，含 roomId + agentName）
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  const SERVER = "http://127.0.0.1:${port}";
  const ROOM = "${roomId}";
  const AGENT = "${agentName}";

  pi.registerTool({
    name: "chat",
    label: "Chat",
    description: "Post a message to the group chat room.",
    parameters: Type.Object({
      message: Type.String({ description: "Message to post" }),
    }),
    async execute(id, params) {
      await fetch(`${SERVER}/internal/tool-callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "chat", room: ROOM, agent: AGENT, params }),
      });
      return { content: [{ type: "text", text: "Message sent to room." }], details: {} };
    },
  });

  pi.registerTool({
    name: "mention",
    label: "Mention",
    description: "Mention and activate another agent. Room members: ${roomMembers}",
    parameters: Type.Object({
      agent: Type.String({ description: "Target agent name" }),
      message: Type.String({ description: "Message to post" }),
    }),
    async execute(id, params) {
      await fetch(`${SERVER}/internal/tool-callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "mention", room: ROOM, agent: AGENT, params }),
      });
      return { content: [{ type: "text", text: `@${params.agent} notified.` }], details: {} };
    },
  });

  // save_knowledge, query_knowledge 同理
}
```

Extension 文件写入 `/tmp/bossmode-ext-${roomId}-${agentName}.ts`。

### 事件映射

Pi RPC 事件和之前 pi-mono 的 AgentEvent 格式一致，映射逻辑不变：

| Pi Event | → AgentStreamEvent |
|----------|-------------------|
| `agent_start` | `agent_start` |
| `agent_end` | `agent_end` |
| `message_start` | `message_start` |
| `message_update` (text_delta) | `message_update` { text: delta } |
| `message_update` (thinking_delta) | `message_update` { thinking: delta } |
| `message_end` | `message_end` { text, usage } |
| `tool_execution_start` | `tool_start` |
| `tool_execution_update` | `tool_update` |
| `tool_execution_end` | `tool_end` |

### RPC 操作映射

| AgentHandle 方法 | Pi RPC 命令 |
|-----------------|------------|
| `prompt(msg)` | `{"type":"prompt","message":"..."}` |
| `steer(msg)` | `{"type":"steer","message":"..."}` |
| `abort()` | `{"type":"abort"}` |
| `waitForIdle()` | 等待 `agent_end` 事件 |
| `isWorking` | 跟踪 agent_start/agent_end 事件 |
| `setModel(m)` | `{"type":"set_model","provider":"...","modelId":"..."}` |
| `setThinkingLevel(l)` | `{"type":"set_thinking_level","level":"..."}` |

## 5. Claude CLI Runtime 实现

### 进程启动

```typescript
const args = [
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--verbose",
  "--system-prompt", opts.agentPrompt,
  "--model", opts.member.model,
  "--effort", mapThinkingToEffort(opts.member.thinkingLevel),
  "--mcp-config", this.mcpConfigPath,
  "--dangerously-skip-permissions",
  "--no-session-persistence",
];

if (opts.teamPrompt) {
  args.push("--append-system-prompt", opts.teamPrompt);
}

// claude 没有 --skill <path>，skill 内容需要拼入 --append-system-prompt
// 或者依赖 claude 自动发现 ~/.agents/skills/ 下的 skill

const proc = spawn("claude", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
```

### Thinking Level 映射

```typescript
function mapThinkingToEffort(level: string): string {
  const map: Record<string, string> = {
    "off": "low", "minimal": "low", "low": "low",
    "medium": "medium", "high": "high", "xhigh": "max",
  };
  return map[level] || "medium";
}
```

### 自定义工具 — MCP Server

bossmode 的 HTTP server 新增 `/mcp` 端点，处理 MCP JSON-RPC 协议（参考 openteam 实现）。

每个 agent 实例生成临时 MCP 配置文件：

```json
// /tmp/bossmode-mcp-${roomId}-${agentName}.json
{
  "mcpServers": {
    "bossmode": {
      "command": "node",
      "args": ["/path/to/bossmode/dist/mcp-server.js"],
      "env": {
        "BOSSMODE_SERVER": "http://127.0.0.1:8080",
        "BOSSMODE_ROOM": "${roomId}",
        "BOSSMODE_AGENT": "${agentName}"
      }
    }
  }
}
```

MCP server（`src/server/mcp-server.ts`）注册工具：chat, mention, save_knowledge, query_knowledge。工具内部通过 HTTP 回调 bossmode 主 server。

也可以用 openteam 的 HTTP transport 模式（共用 bossmode 的 HTTP server 端口），避免额外进程。

### 事件映射

Claude stream-json 输出格式和 pi 完全不同，需要独立映射：

| Claude Event | → AgentStreamEvent |
|-------------|-------------------|
| `system` (init) | 不映射（内部用于初始化） |
| `assistant` 开始 | `message_start` |
| `assistant` (text content) | `message_update` { text } |
| `assistant` (thinking content) | `message_update` { thinking } |
| `assistant` (tool_use content) | `tool_start` |
| `user` (tool_result) | `tool_end` |
| `result` (success) | `message_end` + `agent_end` |
| `result` (error) | `agent_end` (error) |

**注意**：Claude 的 assistant 消息是整块输出的（包含 text + tool_use），不像 pi 那样有细粒度的 text_delta 流。需要解析 content blocks 来拆分事件。

### 操作映射

| AgentHandle 方法 | Claude stdin |
|-----------------|-------------|
| `prompt(msg)` | `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}` |
| `steer(msg)` | 同 prompt（Claude 多轮模式下直接发 user message） |
| `abort()` | 进程 SIGTERM 或 stdin 发 interrupt control_request |
| `waitForIdle()` | 等待 `result` 事件 |
| `isWorking` | 跟踪 assistant / result 事件 |
| `setModel(m)` | ❌ 不支持（需重启进程） |
| `setThinkingLevel(l)` | ❌ 不支持（需重启进程） |

## 6. 内部回调端点

bossmode server 新增内部端点（不需要 auth），处理 CLI agent 的工具回调：

```
POST /internal/tool-callback
Body: { tool: "chat"|"mention"|"save_knowledge"|"query_knowledge", room, agent, params }
```

这个端点由 pi extension 和 claude MCP server 调用。统一处理逻辑：

```typescript
switch (body.tool) {
  case "chat":
    const msg = roomStore.addMessage(body.room, { sender: body.agent, content: body.params.message, mentions: [] });
    broadcastToRoom(body.room, { type: "room:message", roomId: body.room, message: msg });
    break;
  case "mention":
    const msg2 = roomStore.addMessage(body.room, { sender: body.agent, content: body.params.message, mentions: [body.params.agent] });
    broadcastToRoom(body.room, { type: "room:message", roomId: body.room, message: msg2 });
    activateAgent(body.room, body.params.agent);
    break;
  case "save_knowledge": ...
  case "query_knowledge": ...
}
```

## 7. 文件结构

```
src/core/runtime/
├── types.ts                 # 接口定义（AgentRuntime, AgentHandle, events）
├── pi-cli.ts                # PiCliRuntime — spawn pi --mode rpc, 事件映射, extension 生成
├── claude-cli.ts            # ClaudeCliRuntime — spawn claude stream-json, 事件映射, MCP 配置生成
└── registry.ts              # RuntimeRegistry — 从 config.json 加载 enabled runtimes

src/server/
├── mcp-server.ts            # MCP stdio server（claude CLI 的自定义工具）
├── api.ts                   # 新增 /internal/tool-callback 端点
└── ...

src/store/
├── member-store.ts          # Member CRUD（读写 members.json）
└── ...
```

## 8. 删除 pi-mono 依赖

从 `package.json` 删除：
```
"@mariozechner/pi-coding-agent"
"@mariozechner/pi-agent-core"
"@mariozechner/pi-ai"
"@sinclair/typebox"
```

删除文件：
- `src/core/runtime/pi-mono.ts`

重写文件：
- `src/core/agent-manager.ts` — 使用 RuntimeRegistry，按 member.runtime 选择 runtime
- `src/server/index.ts` — 启动时初始化 RuntimeRegistry 而非 PiMonoRuntime

## 9. 实现阶段

### Phase A: 基础设施
1. 删除 pi-mono 依赖，清理 runtime/pi-mono.ts
2. 实现 runtime/types.ts（接口定义）
3. 实现 runtime/registry.ts（从 config 加载）
4. 实现 store/member-store.ts（Member CRUD）
5. 新增 /internal/tool-callback 端点
6. 改造 agent-manager（RuntimeRegistry 注入，按 member 选 runtime）

### Phase B: Pi CLI Runtime
1. 实现 runtime/pi-cli.ts（spawn, RPC 通信, 事件映射）
2. Extension 文件生成逻辑
3. 端到端测试：创建 room → @ member → agent 工作 → chat 回调

### Phase C: Claude CLI Runtime
1. 实现 runtime/claude-cli.ts（spawn, stream-json 通信, 事件映射）
2. 实现 src/server/mcp-server.ts
3. MCP 配置文件生成逻辑
4. 端到端测试

### Phase D: 前端适配
1. Member 管理页面（选 agent + model + runtime + skills + thinking）
2. Settings 页面 Runtime 配置（检测 + 启用/禁用）
3. CreateRoomDialog 改为选 member 而非 agent
4. 能力降级：根据 runtime.capabilities 隐藏不可用功能

## 10. 风险

| 风险 | 缓解 |
|------|------|
| CLI 进程资源消耗（每个 agent 一个进程） | 监控内存，考虑 idle agent 进程回收 |
| Extension/MCP 文件管理（临时文件清理） | daemon shutdown 时清理 /tmp/bossmode-* |
| Claude deferred tools 增加一次 LLM 调用 | 可接受的开销，不影响功能 |
| Pi extension TypeScript 编译 | pi 内部处理，不需要 bossmode 编译 |
| Claude --dangerously-skip-permissions 安全性 | 单用户工具，可接受；后续可改为 --permission-mode auto |
