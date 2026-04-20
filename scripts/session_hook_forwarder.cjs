#!/usr/bin/env node

const http = require("node:http");

const [, , port, roomId, agentName] = process.argv;

if (!port || !roomId || !agentName) {
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input || "{}");
    const sessionId = parsed?.session_id || parsed?.sessionId;
    if (!sessionId) {
      process.exit(0);
      return;
    }

    const body = JSON.stringify({ session_id: sessionId, roomId, agentName });
    const req = http.request({
      method: "POST",
      host: "127.0.0.1",
      port: Number(port),
      path: "/internal/session-hook",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, () => {
      process.exit(0);
    });

    req.on("error", () => process.exit(0));
    req.write(body);
    req.end();
  } catch {
    process.exit(0);
  }
});

process.stdin.on("error", () => process.exit(0));
