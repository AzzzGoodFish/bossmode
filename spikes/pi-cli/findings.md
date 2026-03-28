# Pi CLI 可行性验证结果（完整版）

## P1: --mode rpc 协议 ✅ 完整验证

**结果**：pi RPC 模式是一个完整的双向 JSON 协议，功能远超预期。

**核心命令**：
| 命令 | 功能 | bossmode 需要 |
|------|------|-------------|
| `prompt` | 发送消息，支持 `streamingBehavior: "steer"` | ✅ 激活 agent |
| `steer` | 工作中注入消息 | ✅ 私聊 steer、@ 正在工作的 agent |
| `follow_up` | agent 完成后追加消息 | ✅ 有用 |
| `abort` | 中止当前操作 | ✅ graceful shutdown |
| `set_model` | 动态切换模型 | ✅ dynamicModel 能力 |
| `set_thinking_level` | 动态切换思考级别 | ✅ thinkingLevel 能力 |
| `get_state` | 查询 isStreaming 等状态 | ✅ 状态判断 |
| `compact` | 手动压缩上下文 | 可选 |
| `new_session` | 新建会话 | 可选 |

**事件流**：和 pi-mono 库的 AgentEvent 完全一致（已通过 --mode json 实际验证）。

**关键细节**：
- RPC 是持久进程，支持多轮对话（不是 one-shot）
- steer 在 streaming 期间有效
- 支持 extension UI 子协议（select/confirm/input 等，bossmode 可以忽略）

## P2: --skill 加载机制 ✅ 文档确认

**结果**：skill 是**渐进式加载（progressive disclosure）**，不是全量注入。

工作方式：
1. 启动时扫描 skill 目录，提取 name 和 description
2. **仅 description 以 XML 格式写入 system prompt**（`<available_skills>` 标签）
3. agent 工作时如果判断需要某个 skill，用 `read` 工具加载 SKILL.md 完整内容
4. 用户也可以通过 `/skill:name` 强制加载

**对 bossmode 的影响**：
- `--skill <path>` 注册 skill 但不自动注入全文 → agent 可能不主动加载
- 如果 bossmode 想确保 skill 始终在上下文中，有三种策略：
  1. **用 --append-system-prompt 手动注入** — 简单粗暴，但和 pi-mono 行为一致
  2. **用 --skill 注册 + 在 system prompt 中指示 agent 先加载所有 skill** — 利用原生机制
  3. **在 prompt 消息中加 `/skill:name`** — RPC 模式下 skill 命令会被展开后注入

建议策略 1（--append-system-prompt 注入），保持跨 runtime 行为一致。

## P3: --extension 自定义工具 ✅ 文档 + 源码确认

**结果**：extension 通过 `pi.registerTool()` 注册工具，RPC 模式下完全支持。

工具注册格式：
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "chat",
    label: "Chat",
    description: "Post message to bossmode group chat",
    parameters: Type.Object({
      message: Type.String({ description: "Message to post" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // HTTP 回调 bossmode server
      const res = await fetch("http://127.0.0.1:8080/internal/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: params.message }),
      });
      return { content: [{ type: "text", text: "Message sent." }], details: {} };
    },
  });
}
```

**Extension 注意事项**：
- TypeScript 文件，pi 内部编译执行
- `--extension path.ts` 传入，RPC 模式下可用
- Extension 还可以拦截事件（tool_call, agent_start/end 等）
- Extension 的 UI 方法在 RPC 模式下通过子协议通信（bossmode 不需要）

## P4: RPC steer 支持 ✅ 文档确认

```json
{"type": "steer", "message": "Stop and do this instead"}
```
Agent 工作中发送，下次 LLM 调用前注入。完全支持。

## P5: RPC 事件流格式 ✅ 已验证

和 pi-mono AgentEvent 完全一致。包括：
- agent_start/end, turn_start/end
- message_start/update/end（含 text_delta, thinking_delta, toolcall_delta）
- tool_execution_start/update/end
- auto_compaction_start/end
- auto_retry_start/end

## 综合评估

**pi CLI 通过 RPC 模式完全满足 bossmode 的 runtime 需求**：

| 需求 | 支持 | 方式 |
|------|------|------|
| 创建 agent | ✅ | spawn `pi --mode rpc` 进程 |
| 传 system prompt | ✅ | `--system-prompt` + `--append-system-prompt` |
| 传 skill | ✅ | `--append-system-prompt`（手动注入）或 `--skill`（渐进式） |
| 传 model | ✅ | `--model` 启动参数 + `set_model` 运行时切换 |
| 传 thinking level | ✅ | `--thinking` 启动参数 + `set_thinking_level` 运行时切换 |
| prompt | ✅ | `{"type": "prompt", "message": "..."}` |
| steer | ✅ | `{"type": "steer", "message": "..."}` |
| abort | ✅ | `{"type": "abort"}` |
| 事件流 | ✅ | stdout JSONL，和 pi-mono 格式一致 |
| 自定义工具 | ✅ | `--extension` TypeScript 文件 |
| 动态改 model | ✅ | `set_model` 命令 |
| 动态改 thinking | ✅ | `set_thinking_level` 命令 |
| 多轮对话 | ✅ | RPC 进程持久运行 |
| 会话管理 | ✅ | `new_session`, `switch_session`, `compact` |
