import { spawn } from "node:child_process";

const proc = spawn("claude", [
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--verbose",
  "--system-prompt", "test agent",
  "--model", "claude-sonnet-4-6",
  "--dangerously-skip-permissions",
  "--no-session-persistence",
], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });

proc.stdout.on("data", (d) => console.log("[OUT]", d.toString().slice(0, 200)));
proc.stderr.on("data", (d) => console.error("[ERR]", d.toString().slice(0, 200)));
proc.on("exit", (code) => console.log("[EXIT]", code));
setTimeout(() => { console.log("[TIMEOUT]"); proc.kill(); }, 10000);
