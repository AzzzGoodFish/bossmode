// C3: Test MCP tool in stream-json mode
import { spawn } from "node:child_process";

const proc = spawn("claude", [
  "--output-format", "stream-json",
  "--verbose",
  "--input-format", "stream-json",
  "--dangerously-skip-permissions",
  "--mcp-config", "/home/fish/dev/llm/bossmode/spikes/claude-cli/c3-mcp-config.json",
  "--strict-mcp-config",
], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "/home/fish/dev/llm/bossmode/spikes/claude-cli",
});

proc.stdout.on("data", (data) => {
  for (const line of data.toString().split("\n").filter(Boolean)) {
    try {
      const msg = JSON.parse(line);
      console.log(`[${msg.type}]`, JSON.stringify(msg).slice(0, 300));
    } catch {
      console.log("[RAW]", line.slice(0, 200));
    }
  }
});

proc.stderr.on("data", (data) => {
  for (const line of data.toString().split("\n").filter(Boolean)) {
    console.error("[ERR]", line.slice(0, 200));
  }
});

proc.on("exit", (code) => console.log("[EXIT]", code));

// Wait for init, then ask to call the hello tool
setTimeout(() => {
  const msg = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "Please call the hello tool with name 'World'. Just call the tool, nothing else." }],
    },
  };
  console.log("[SEND]", JSON.stringify(msg).slice(0, 200));
  proc.stdin.write(JSON.stringify(msg) + "\n");
}, 3000);

setTimeout(() => { console.log("[TIMEOUT]"); proc.kill(); }, 60000);
