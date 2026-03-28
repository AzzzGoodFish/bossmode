# P1: pi --mode json 协议验证

## 结果：✅ 成功

## 命令
```bash
pi --mode json --no-tools --no-extensions --no-skills --no-session --print --model anthropic/claude-haiku "Say hello in exactly 3 words"
```

## 关键发现

**pi CLI 的 json 输出格式和 pi-mono 库的 AgentEvent 完全一致！**

事件流顺序：
```
session        → { version: 3, id, timestamp, cwd }
agent_start    → {}
turn_start     → {}
message_start  → { message: { role: "user", content: [...] } }
message_end    → { message: { role: "user", ... } }
message_start  → { message: { role: "assistant", content: [] } }
message_update → { assistantMessageEvent: { type: "thinking_start", ... } }
message_update → { assistantMessageEvent: { type: "thinking_delta", delta: "..." } }
...
message_update → { assistantMessageEvent: { type: "thinking_end", ... } }
message_update → { assistantMessageEvent: { type: "text_start", ... } }
message_update → { assistantMessageEvent: { type: "text_delta", delta: "Hello there friend." } }
message_update → { assistantMessageEvent: { type: "text_end", ... } }
message_end    → { message: { role: "assistant", content: [...], usage: { input, output, cost } } }
turn_end       → { message, toolResults: [] }
agent_end      → { messages: [...] }
```

## 意义

1. pi-cli runtime 的事件映射可以直接复用 pi-mono runtime 的映射逻辑
2. usage/cost 数据在 message_end 中有完整返回
3. thinking 内容通过 thinking_delta 流式输出
4. `--print` 模式下进程执行完就退出（one-shot）

## 待确认
- `--mode rpc` 可能支持多轮对话（非 one-shot），需要单独验证
- `--mode json` 不加 `--print` 时是否支持交互式多轮
