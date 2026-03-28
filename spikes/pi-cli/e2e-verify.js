// E2E verification: PiCliRuntime with real pi CLI
// Tests: spawn → prompt → chat tool callback → events
import http from "node:http";

// 1. Start a minimal callback server
const callbacks = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/internal/tool-callback") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      callbacks.push(body);
      console.log("[CALLBACK]", JSON.stringify(body).slice(0, 200));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const PORT = 19876;
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
console.log(`[SERVER] Listening on port ${PORT}`);

// 2. Import and create PiCliRuntime
const { PiCliRuntime } = await import("../../dist/core/runtime/pi-cli.js");
const runtime = new PiCliRuntime(undefined, PORT);

const detectResult = await runtime.detect();
console.log("[DETECT]", detectResult);
if (!detectResult.available) {
  console.error("pi CLI not available!");
  process.exit(1);
}

// 3. Create agent
const events = [];
let agentDone = false;

try {
  console.log("[CREATE] Creating agent...");
  const handle = await runtime.createAgent({
    cwd: "/tmp",
    member: {
      id: "test",
      name: "test-agent",
      agentSource: "test.md",
      model: "anthropic/claude-sonnet-4-6",
      runtime: "pi-cli",
      skills: [],
      thinkingLevel: "off",
    },
    agentPrompt: "You are a test agent. When asked to greet, use the 'chat' tool to post 'Hello from test agent!' to the room. Do not write any text response, just call the chat tool.",
    skillPaths: [],
    roomMembers: ["test-agent", "other-agent"],
    callbacks: {
      onChat: async (msg) => { console.log("[onChat]", msg); },
      onMention: async (target, msg) => { console.log("[onMention]", target, msg); },
    },
  });

  // Subscribe to events
  handle.subscribe((event) => {
    events.push(event);
    console.log(`[EVENT] ${event.type}`, JSON.stringify(event).slice(0, 150));
    if (event.type === "agent_end") agentDone = true;
  });

  console.log("[PROMPT] Sending prompt...");
  await handle.prompt("Please greet the room using the chat tool.");

  // Wait for completion
  console.log("[WAIT] Waiting for agent to finish...");
  await handle.waitForIdle();

  console.log("\n=== RESULTS ===");
  console.log("Events:", events.length);
  console.log("Event types:", events.map(e => e.type).join(", "));
  console.log("Callbacks:", callbacks.length);
  console.log("Chat callbacks:", callbacks.filter(c => c.tool === "chat").length);

  const chatCallback = callbacks.find(c => c.tool === "chat");
  if (chatCallback) {
    console.log("✅ Chat tool callback received:", chatCallback.params?.message);
  } else {
    console.log("❌ No chat tool callback received");
  }

  const hasAgentStart = events.some(e => e.type === "agent_start");
  const hasAgentEnd = events.some(e => e.type === "agent_end");
  const hasMessageEnd = events.some(e => e.type === "message_end");

  console.log(`Agent lifecycle: start=${hasAgentStart}, end=${hasAgentEnd}, messageEnd=${hasMessageEnd}`);

  if (hasAgentStart && hasAgentEnd && chatCallback) {
    console.log("\n✅ E2E VERIFICATION PASSED");
  } else {
    console.log("\n❌ E2E VERIFICATION FAILED");
  }

  // Cleanup
  await runtime.shutdownAll();
} catch (err) {
  console.error("[ERROR]", err);
}

server.close();
process.exit(0);
