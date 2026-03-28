// C1: Probe stream-json - matching happy-coder's exact flags
import { spawn } from "node:child_process";

const proc = spawn("claude", [
  "--output-format", "stream-json",
  "--verbose",
  "--input-format", "stream-json",
  "--dangerously-skip-permissions",
], {
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stdout.on("data", (data) => {
  for (const line of data.toString().split("\n").filter(Boolean)) {
    console.log("[OUT]", line);
  }
});

proc.stderr.on("data", (data) => {
  for (const line of data.toString().split("\n").filter(Boolean)) {
    console.error("[ERR]", line);
  }
});

proc.on("exit", (code) => console.log("[EXIT]", code));

// Wait for system message, then send user message
setTimeout(() => {
  const msg = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "What is 2+2? Reply with just the number." }],
    },
  };
  console.log("[SEND]", JSON.stringify(msg));
  proc.stdin.write(JSON.stringify(msg) + "\n");
}, 2000);

setTimeout(() => { console.log("[TIMEOUT]"); proc.kill(); }, 45000);
