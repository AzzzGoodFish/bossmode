// Debug: see what claude outputs on startup
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mcpConfig = {
  mcpServers: {
    bossmode: {
      command: "node",
      args: ["/home/fish/dev/llm/bossmode/dist/server/mcp-server.js"],
      env: {
        BOSSMODE_SERVER: "http://127.0.0.1:19879",
        BOSSMODE_ROOM: "test-room",
        BOSSMODE_AGENT: "test",
        BOSSMODE_MEMBERS: "test",
      },
    },
  },
};
const configPath = "/tmp/bossmode-mcp-debug.json";
writeFileSync(configPath, JSON.stringify(mcpConfig));

const proc = spawn("claude", [
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--verbose",
  "--system-prompt", "You are a test agent. Reply briefly.",
  "--model", "claude-sonnet-4-6",
  "--mcp-config", configPath,
  "--strict-mcp-config",
  "--dangerously-skip-permissions",
  "--no-session-persistence",
], {
  cwd: "/tmp",
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n").filter(Boolean)) {
    console.log("[OUT]", line.slice(0, 200));
  }
});

proc.stderr.on("data", (d) => {
  for (const line of d.toString().split("\n").filter(Boolean)) {
    console.error("[ERR]", line.slice(0, 200));
  }
});

proc.on("exit", (code) => console.log("[EXIT]", code));

setTimeout(() => {
  console.log("[TIMEOUT 20s]");
  proc.kill();
}, 20000);
