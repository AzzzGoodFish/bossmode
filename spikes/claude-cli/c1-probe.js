// C1: Probe stream-json protocol
import { spawn } from "node:child_process";

const proc = spawn("claude", [
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--print",
  "--verbose",
  "--dangerously-skip-permissions",
], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Collect stdout
proc.stdout.on("data", (data) => {
  const lines = data.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    console.log("[STDOUT]", line);
  }
});

proc.stderr.on("data", (data) => {
  const text = data.toString().trim();
  if (text) console.error("[STDERR]", text);
});

proc.on("exit", (code) => {
  console.log("[EXIT]", code);
});

// Send message after a short delay
setTimeout(() => {
  const msg = JSON.stringify({
    type: "user_message",
    message: {
      role: "user",
      content: [{ type: "text", text: "What is 2+2? Reply with just the number." }],
    },
  });
  console.log("[STDIN]", msg);
  proc.stdin.write(msg + "\n");
}, 500);

// Kill after 30s timeout
setTimeout(() => {
  console.log("[TIMEOUT] 30s");
  proc.kill();
}, 30000);
