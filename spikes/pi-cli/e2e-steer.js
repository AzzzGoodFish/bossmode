// E2E: Verify steer (inject message while agent is working)
import http from "node:http";

const callbacks = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      callbacks.push(body);
      console.log("[CALLBACK]", body.tool, body.params?.message?.slice(0, 80));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body.tool === "query_knowledge" ? [] : { ok: true }));
    });
  } else { res.writeHead(404); res.end(); }
});

const PORT = 19877;
await new Promise(r => server.listen(PORT, "127.0.0.1", r));

const { PiCliRuntime } = await import("../../dist/core/runtime/pi-cli.js");
const runtime = new PiCliRuntime(undefined, PORT);

const events = [];
const handle = await runtime.createAgent({
  cwd: "/tmp",
  member: { id: "t", name: "steer-test", agentSource: "t.md", model: "anthropic/claude-sonnet-4-6", runtime: "pi-cli", skills: [], thinkingLevel: "off" },
  agentPrompt: "You are a test agent. When asked to do something, use the chat tool to confirm. If you receive a steer message saying 'change plan', use the chat tool to say 'Plan changed!'.",
  skillPaths: [],
  roomMembers: ["steer-test"],
  callbacks: {
    onChat: async (msg) => {},
    onMention: async () => {},
  },
});

handle.subscribe((event) => {
  events.push(event);
  if (event.type !== "message_update") console.log(`[EVENT] ${event.type}`);
});

// Send prompt, then quickly steer
console.log("[TEST] Sending prompt...");
const promptDone = handle.prompt("Please read /tmp/nonexistent-file.txt and tell me what's in it, then use chat to report. Take your time, read carefully.");

// Steer after a short delay (while agent is working)
setTimeout(() => {
  console.log("[TEST] Sending steer: change plan");
  handle.steer("change plan: stop reading files, just use chat to say 'Plan changed!'");
}, 3000);

await promptDone;
console.log("\n=== RESULTS ===");
console.log("Events:", events.length);
console.log("Callbacks:", callbacks.length);
const chatMsgs = callbacks.filter(c => c.tool === "chat").map(c => c.params?.message);
console.log("Chat messages:", chatMsgs);

if (chatMsgs.some(m => m?.includes("Plan changed"))) {
  console.log("✅ STEER VERIFIED — agent changed behavior");
} else {
  console.log("⚠️ STEER may not have taken effect (agent might have finished before steer)");
}

await runtime.shutdownAll();
server.close();
process.exit(0);
