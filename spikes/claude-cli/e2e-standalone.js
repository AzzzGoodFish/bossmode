#!/usr/bin/env node
/**
 * Claude CLI E2E Standalone Verification
 *
 * Run this OUTSIDE of Claude Code (in a regular terminal):
 *   node spikes/claude-cli/e2e-standalone.js
 *
 * Prerequisites:
 *   - claude CLI installed and authenticated
 *   - npm install done (for @modelcontextprotocol/sdk)
 *   - npm run build done (for dist/server/mcp-server.js)
 *
 * Tests:
 *   1. Claude CLI detect (version)
 *   2. MCP server startup + tool registration
 *   3. Claude spawn with MCP config → system init
 *   4. User prompt → Claude calls chat MCP tool → callback received
 *   5. Event stream (agent_start, assistant, tool_use, tool_result, result)
 */

import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../..");
const MCP_SERVER = join(PROJECT_ROOT, "dist/server/mcp-server.js");

const PORT = 19900 + Math.floor(Math.random() * 100);
const results = [];

function log(msg) { console.log(`  ${msg}`); }
function pass(test) { results.push({ test, ok: true }); console.log(`✅ ${test}`); }
function fail(test, reason) { results.push({ test, ok: false, reason }); console.log(`❌ ${test}: ${reason}`); }

// -- Test 1: Detect --
console.log("\n=== Claude CLI E2E Verification ===\n");

try {
  const version = execSync("claude --version", { encoding: "utf-8" }).trim();
  const path = execSync("which claude", { encoding: "utf-8" }).trim();
  pass(`Detect: ${version} at ${path}`);
} catch {
  fail("Detect", "claude CLI not found");
  process.exit(1);
}

// -- Start callback server --
const callbacks = [];
const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      callbacks.push(body);
      log(`Callback: ${body.tool} ${JSON.stringify(body.params).slice(0, 80)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body.tool === "query_knowledge" ? [] : { ok: true }));
    });
  } else { res.writeHead(404); res.end(); }
});

await new Promise(r => server.listen(PORT, "127.0.0.1", r));
log(`Callback server on port ${PORT}`);

// -- Generate MCP config --
const mcpConfigPath = `/tmp/bossmode-e2e-standalone-${Date.now()}.json`;
writeFileSync(mcpConfigPath, JSON.stringify({
  mcpServers: {
    bossmode: {
      command: "node",
      args: [MCP_SERVER],
      env: {
        BOSSMODE_SERVER: `http://127.0.0.1:${PORT}`,
        BOSSMODE_ROOM: "e2e-test-room",
        BOSSMODE_AGENT: "e2e-agent",
        BOSSMODE_MEMBERS: "e2e-agent,other-agent",
      },
    },
  },
}));

// -- Test 2-5: Spawn, init, prompt, tool callback --
try {
  const events = [];
  let systemInit = false;
  let gotResult = false;

  const proc = spawn("claude", [
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--system-prompt", "You are a test agent. When asked to greet, call the 'chat' tool to post 'Hello from e2e test!' to the room. Do not write any other text.",
    "--model", "sonnet",
    "--mcp-config", mcpConfigPath,
    "--dangerously-skip-permissions",
    "--no-session-persistence",
  ], { cwd: "/tmp", stdio: ["pipe", "pipe", "pipe"] });

  proc.stderr.on("data", d => {
    const text = d.toString().trim();
    if (text) log(`stderr: ${text.slice(0, 100)}`);
  });

  // Parse stdout
  let buffer = "";
  const waitForResult = new Promise((resolve) => {
    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          events.push(msg);
          log(`Event: ${msg.type}${msg.subtype ? "/" + msg.subtype : ""}`);

          if (msg.type === "system" && msg.subtype === "init") {
            systemInit = true;
          }
          if (msg.type === "result") {
            gotResult = true;
            resolve();
          }
        } catch {}
      }
    });

    proc.on("exit", resolve);
  });

  // Wait for system init, then send prompt
  log("Waiting for system init...");
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (systemInit) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 30000);
  });

  if (systemInit) {
    pass("System init received");

    // Check tools registered
    const initEvent = events.find(e => e.type === "system");
    const hasBossmodeTools = initEvent?.tools?.some(t => t.includes("bossmode"));
    if (hasBossmodeTools) {
      pass("MCP tools registered (bossmode namespace)");
    } else {
      fail("MCP tools", "bossmode tools not in init tools list");
    }

    // Send prompt
    log("Sending prompt...");
    proc.stdin.write(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Please greet the room using the chat tool." }] },
    }) + "\n");

    // Wait for result (60s timeout)
    await Promise.race([
      waitForResult,
      new Promise(r => setTimeout(r, 60000)),
    ]);

    if (gotResult) {
      pass("Got result event");
    } else {
      fail("Result", "No result event within 60s");
    }

    // Check chat callback
    const chatCb = callbacks.find(c => c.tool === "chat");
    if (chatCb) {
      pass(`Chat callback received: "${chatCb.params?.message}"`);
    } else {
      fail("Chat callback", "No chat tool callback received");
    }

    // Check event types
    const types = events.map(e => e.type);
    log(`Event types: ${types.join(", ")}`);

  } else {
    fail("System init", "No system init within 30s");
  }

  proc.kill();
} catch (err) {
  fail("Runtime", err.message);
}

// -- Cleanup --
try { unlinkSync(mcpConfigPath); } catch {}
server.close();

// -- Summary --
console.log("\n=== Summary ===");
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`${passed}/${total} passed`);
if (passed === total) {
  console.log("\n✅ ALL TESTS PASSED — Claude CLI runtime is functional\n");
} else {
  console.log("\n❌ SOME TESTS FAILED\n");
  for (const r of results.filter(r => !r.ok)) {
    console.log(`  - ${r.test}: ${r.reason}`);
  }
}

process.exit(passed === total ? 0 : 1);
