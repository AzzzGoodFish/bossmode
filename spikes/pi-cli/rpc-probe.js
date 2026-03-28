// Quick spike: verify pi --mode rpc protocol
import { spawn } from "node:child_process";

const proc = spawn("pi", [
  "--mode", "rpc",
  "--system-prompt", "You are a test agent. Reply briefly.",
  "--model", "anthropic/claude-sonnet-4-6",
  "--thinking", "off",
  "--no-session",
  "--no-extensions",
  "--no-skills",
], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "/tmp",
});

let buffer = "";
proc.stdout.on("data", (data) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      console.log(`[${msg.type}]`, JSON.stringify(msg).slice(0, 250));
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

// Wait for init, then send prompt
setTimeout(() => {
  const cmd = { type: "prompt", message: "What is 2+2? Reply with just the number." };
  console.log("[SEND]", JSON.stringify(cmd));
  proc.stdin.write(JSON.stringify(cmd) + "\n");
}, 2000);

setTimeout(() => { console.log("[TIMEOUT]"); proc.kill(); }, 30000);
