import { spawn } from "node:child_process";

// Exact same flags as the C1 probe that worked
const proc = spawn("claude", [
  "--output-format", "stream-json",
  "--verbose",
  "--input-format", "stream-json",
  "--dangerously-skip-permissions",
], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });

proc.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n").filter(Boolean)) {
    console.log("[OUT]", line.slice(0, 200));
  }
});
proc.stderr.on("data", (d) => console.error("[ERR]", d.toString().slice(0, 100)));
proc.on("exit", (code) => console.log("[EXIT]", code));

setTimeout(() => {
  const msg = { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
  proc.stdin.write(JSON.stringify(msg) + "\n");
  console.log("[SENT]");
}, 3000);

setTimeout(() => { console.log("[TIMEOUT]"); proc.kill(); }, 20000);
