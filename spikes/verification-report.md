# Runtime 可行性验证报告

**Date**: 2026-03-24
**验证人**: Architect (pi CLI) + Developer (claude CLI)

---

## 总结

**三种 runtime 全部技术可行**，无阻断性风险。

| Runtime | 可行性 | 验证覆盖 |
|---------|--------|---------|
| pi-mono（库） | ✅ 已在 v1 使用 | 生产验证 |
| pi CLI（RPC） | ✅ 全部通过 | P1-P5 |
| claude CLI（stream-json） | ✅ 全部通过 | C1, C3, C4 |

---

## Pi CLI 验证结果

### P1: RPC 协议 ✅
- `pi --mode rpc` 是完整双向 JSON 协议
- 命令：prompt, steer, follow_up, abort, set_model, set_thinking_level, compact, new_session
- 事件流和 pi-mono 库的 AgentEvent **完全一致**
- 持久进程，支持多轮对话

### P2: Skill 加载 ✅ (行为明确)
- `--skill <path>` 注册 skill，但**不全量注入 system prompt**
- 渐进式加载：仅 description 写入 system prompt，agent 按需用 read 工具加载全文
- **约束**：skill frontmatter name 必须和目录名一致
- **bossmode 策略**：用 `--append-system-prompt` 手动注入 skill 内容，保持跨 runtime 一致

### P3: Extension 自定义工具 ✅
- `pi.registerTool()` 注册工具，接口和 pi-mono AgentTool 一致
- TypeScript 文件，`--extension path.ts` 加载
- RPC 模式下完全支持
- 工具内部通过 HTTP 回调 bossmode server

### P4: Steer 支持 ✅
- `{"type": "steer", "message": "..."}` 在 agent streaming 期间有效

### P5: 动态能力 ✅
- `set_model`: 运行时切换模型
- `set_thinking_level`: 运行时切换思考级别

---

## Claude CLI 验证结果

### C1: stream-json 协议 ✅
- 持续模式：`claude --output-format stream-json --verbose --input-format stream-json`（**不加 --print**）
- 单次模式：加 `--print` + `--verbose`
- 输入：`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- 输出事件：system(init), assistant, user(tool_result), rate_limit_event, result
- result 后进程不退出，等待下一条输入（多轮支持）

### C3: MCP 工具在 stream-json 模式 ✅
- stdio transport MCP server 完全可用
- `--mcp-config <path>` 指定配置
- Claude 通过 deferred tools 机制发现 MCP 工具（先 ToolSearch 获取 schema）
- `--strict-mcp-config` 有效：只加载指定 MCP server

### C4: --agent + --append-system-prompt 共存 ✅
- 两个参数完全兼容
- agent 定义 + 追加 prompt 内容同时生效

---

## 关键发现与设计影响

### 1. Skill 传递策略统一为 --append-system-prompt
pi 和 claude 的 `--skill` 都不是全量注入。bossmode 应自己读取 skill 内容，通过 `--append-system-prompt`（CLI）或直接拼 system prompt（库模式）注入。跨 runtime 行为一致。

### 2. Pi CLI 和 Pi-mono 事件格式一致
pi-cli runtime 的事件映射逻辑可以直接复用 pi-mono 的实现，大幅减少工作量。

### 3. Claude CLI 事件格式不同
Claude 的 stream-json 输出（assistant/user/result）和 pi 的事件格式（agent_start/message_update/tool_execution_start）完全不同。claude-cli runtime 需要独立的事件映射层。

### 4. 自定义工具注册方式不同
- pi-mono: 代码注入 AgentTool[]
- pi CLI: extension TypeScript 文件 (--extension)
- claude CLI: MCP stdio server (--mcp-config)

三种方式都已验证可行。bossmode 需要为 chat/mention/save_knowledge/query_knowledge 工具维护：
- pi extension 文件（pi-mono + pi CLI 共用 AgentTool 接口）
- MCP server（claude CLI 专用）

### 5. Claude CLI 的 deferred tools 机制
MCP 工具默认是 deferred 的，Claude 需要先调 ToolSearch 获取 schema。这增加了一个 LLM 调用的开销，但不影响功能。

### 6. --bare 模式不可用
Claude 的 `--bare` 模式需要 ANTHROPIC_API_KEY，不兼容 Claude Max OAuth 认证。bossmode 不应使用 --bare。

---

## 三种 Runtime 的完整参数对照

| 功能 | pi-mono（库） | pi CLI (RPC) | claude CLI (stream-json) |
|------|-------------|-------------|-------------------------|
| 启动 | `new Agent(opts)` | `pi --mode rpc [flags]` | `claude --output-format stream-json --verbose --input-format stream-json [flags]` |
| System Prompt | 构造参数 | `--system-prompt` | `--system-prompt` 或 `--agent <name>` |
| 追加 Prompt | 拼接 | `--append-system-prompt` | `--append-system-prompt` |
| Skill 注入 | 拼进 prompt | `--append-system-prompt` | `--append-system-prompt` |
| Model | `getModel()` | `--model` + `set_model` | `--model` |
| Thinking | 构造参数 | `--thinking` + `set_thinking_level` | `--effort` |
| Prompt | `agent.prompt()` | `{"type":"prompt"}` | stdin JSON user message |
| Steer | `agent.steer()` | `{"type":"steer"}` | stdin JSON user message（多轮模式） |
| Abort | `agent.abort()` | `{"type":"abort"}` | 进程 signal |
| 自定义工具 | AgentTool[] 注入 | `--extension file.ts` | `--mcp-config file.json` |
| 事件流 | subscribe callback | stdout JSONL (AgentEvent) | stdout JSONL (SDKMessage) |
| 动态改 Model | `setModel()` | `set_model` 命令 | ❌ 需重启进程 |
| 动态改 Thinking | `setThinkingLevel()` | `set_thinking_level` 命令 | ❌ 需重启进程 |
| 权限控制 | ❌ | ❌ | `--permission-mode` / `--dangerously-skip-permissions` |

---

## Spike 代码位置

- Pi CLI: `spikes/pi-cli/`
- Claude CLI: `spikes/claude-cli/`
