// Trace: use ClaudeCliRuntime but with extra logging
import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      console.log("[CB]", Buffer.concat(chunks).toString().slice(0, 100));
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end('{"ok":true}');
    });
  } else { res.writeHead(404); res.end(); }
});

await new Promise(r => server.listen(19878, "127.0.0.1", r));

// Monkey-patch spawn to log args
const child_process = await import("node:child_process");
const origSpawn = child_process.spawn;
child_process.spawn = function(...args) {
  console.log("[SPAWN CMD]", args[0]);
  console.log("[SPAWN ARGS]", JSON.stringify(args[1]).slice(0, 500));
  const proc = origSpawn.apply(this, args);
  proc.stdout?.on("data", d => console.log("[PROC OUT]", d.toString().slice(0, 150)));
  proc.stderr?.on("data", d => console.error("[PROC ERR]", d.toString().slice(0, 150)));
  proc.on("exit", c => console.log("[PROC EXIT]", c));
  return proc;
};

const { ClaudeCliRuntime } = await import("../../dist/core/runtime/claude-cli.js");
const runtime = new ClaudeCliRuntime(undefined, 19878);

try {
  const handle = await runtime.createAgent({
    cwd: "/tmp",
    roomId: "test-room-123",
    member: { id: "t", name: "test", agentSource: "t.md", model: "claude-sonnet-4-6", runtime: "claude-cli", skills: [], thinkingLevel: "off" },
    agentPrompt: "Test agent. Use chat tool to reply.",
    skillPaths: [],
    roomMembers: ["test"],
    callbacks: { onChat: async () => {}, onMention: async () => {} },
  });
  console.log("✅ Agent created!");
} catch(e) {
  console.error("❌", e.message);
}

server.close();
setTimeout(() => process.exit(), 2000);
