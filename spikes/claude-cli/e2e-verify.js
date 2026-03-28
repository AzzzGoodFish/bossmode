// E2E: Claude CLI Runtime verification
import http from "node:http";

const callbacks = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      callbacks.push(body);
      console.log("[CALLBACK]", body.tool, JSON.stringify(body.params).slice(0, 100));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body.tool === "query_knowledge" ? [] : { ok: true }));
    });
  } else { res.writeHead(404); res.end(); }
});

const PORT = 19878;
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
console.log(`[SERVER] on ${PORT}`);

const { ClaudeCliRuntime } = await import("../../dist/core/runtime/claude-cli.js");
const runtime = new ClaudeCliRuntime(undefined, PORT);

const detectResult = await runtime.detect();
console.log("[DETECT]", detectResult);

const events = [];
try {
  console.log("[CREATE] Creating agent...");
  const handle = await runtime.createAgent({
    cwd: "/tmp",
    member: {
      id: "test", name: "claude-test", agentSource: "test.md",
      model: "claude-sonnet-4-6", runtime: "claude-cli",
      skills: [], thinkingLevel: "off",
    },
    agentPrompt: "You are a test agent. When asked to greet, call the 'chat' MCP tool to post 'Hello from Claude!' to the room. Do not write any other text, just call the tool.",
    skillPaths: [],
    roomMembers: ["claude-test", "other"],
    callbacks: {
      onChat: async (msg) => console.log("[onChat]", msg),
      onMention: async () => {},
    },
  });

  console.log("[INIT] Claude started, subscribing to events...");

  handle.subscribe((event) => {
    events.push(event);
    console.log(`[EVENT] ${event.type}`, JSON.stringify(event).slice(0, 150));
  });

  console.log("[PROMPT] Sending...");
  await handle.prompt("Please greet the room using the chat tool.");
  console.log("[DONE] Agent finished");

  console.log("\n=== RESULTS ===");
  console.log("Events:", events.map(e => e.type).join(", "));
  console.log("Callbacks:", callbacks.length);

  const chatCb = callbacks.find(c => c.tool === "chat");
  if (chatCb) console.log("✅ Chat callback:", chatCb.params?.message);
  else console.log("❌ No chat callback");

  const ok = events.some(e => e.type === "agent_start") &&
             events.some(e => e.type === "agent_end") && chatCb;
  console.log(ok ? "\n✅ CLAUDE E2E PASSED" : "\n❌ CLAUDE E2E FAILED");

  await runtime.shutdownAll();
} catch (err) {
  console.error("[ERROR]", err);
}

server.close();
process.exit(0);
