// Debug: manually create ClaudeCliRuntime and see what happens
import http from "node:http";

const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      console.log("[CB]", Buffer.concat(chunks).toString().slice(0, 150));
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end('{"ok":true}');
    });
  } else { res.writeHead(404); res.end(); }
});

await new Promise(r => server.listen(19878, "127.0.0.1", r));
console.log("[SERVER] Ready");

// Import runtime
const { ClaudeCliRuntime } = await import("../../dist/core/runtime/claude-cli.js");
const runtime = new ClaudeCliRuntime(undefined, 19878);

console.log("[DETECT]", await runtime.detect());

// Manually trace what createAgent does
const { spawn } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const { join } = await import("node:path");

const mcpServerPath = join(import.meta.dirname, "../../dist/server/mcp-server.js");
console.log("[MCP_SERVER]", mcpServerPath);

// Check MCP server file exists
const { existsSync } = await import("node:fs");
console.log("[MCP_EXISTS]", existsSync(mcpServerPath));

const mcpConfig = {
  mcpServers: {
    bossmode: {
      command: "node",
      args: [mcpServerPath],
      env: { BOSSMODE_SERVER: "http://127.0.0.1:19878", BOSSMODE_ROOM: "test", BOSSMODE_AGENT: "test", BOSSMODE_MEMBERS: "test" },
    },
  },
};
const configPath = "/tmp/bossmode-mcp-debug2.json";
writeFileSync(configPath, JSON.stringify(mcpConfig));

const args = [
  "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
  "--system-prompt", "You are a test agent.",
  "--model", "sonnet",
  "--mcp-config", configPath,
  "--strict-mcp-config",
  "--dangerously-skip-permissions", "--no-session-persistence",
];

console.log("[SPAWN]", "claude", args.join(" ").slice(0, 200));

const proc = spawn("claude", args, { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });

proc.stdout.on("data", d => {
  for (const line of d.toString().split("\n").filter(Boolean)) {
    console.log("[OUT]", line.slice(0, 150));
  }
});
proc.stderr.on("data", d => console.error("[ERR]", d.toString().slice(0, 150)));
proc.on("exit", c => console.log("[EXIT]", c));

setTimeout(() => { console.log("[TIMEOUT]"); proc.kill(); server.close(); process.exit(); }, 25000);
