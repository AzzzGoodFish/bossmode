#!/usr/bin/env node
// scripts/smoke-e2e.mjs — 端到端沙箱冒烟（架构重构片 0 验收网件）
//
// 真 daemon（built dist）＋ 本进程内假模型 provider（openai-completions 协议）：
// 只假模型；pi SDK、会话、工具链、重启续跑全真。不花真额度。
//
// 三个相位：
//   T terminal：terminal_create → exec（快/慢）→ wait → read → list → close（六件套真调用）
//   L lifecycle：@激活 → 工具回合 → chat_send 回复落回房间（核对 daemon 落账）
//   R restart：在飞慢轮次中 CLI off/on → 成员回到 idle → 重启后续跑落账 → 队列落定
//
// 用法：
//   npm run build                       # 先构建（或 --dist <package-root> 指向已装包）
//   node scripts/smoke-e2e.mjs [--dist <path>] [--keep] [--only T|L|R]
//
// 隔离：临时 HOME/BOSSMODE_DIR（断言在 tmp 下）＋随机端口；不碰真实环境。
// 失败保留现场目录并打印路径；成功默认清理（--keep 保留）。
// 说明：崩溃窗口 / kill -9 / 在飞输入 uncertain 语义等深水区由 qa 演练覆盖，不在本脚本范围。

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";

const requireBuiltin = createRequire(import.meta.url);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(SCRIPT_DIR, "..");

// ---- args ----
const argv = process.argv.slice(2);
const argVal = (name) => { const i = argv.indexOf(name); if (i < 0) return undefined; const v = argv[i + 1]; return v && !v.startsWith("-") ? v : true; };
const DIST = typeof argVal("--dist") === "string" ? path.resolve(argVal("--dist")) : REPO;
const KEEP = argv.includes("--keep");
const ONLY = typeof argVal("--only") === "string" ? argVal("--only").toUpperCase() : null;
const CLI = path.join(DIST, "dist", "cli", "index.js");
const USER = "smoke", PASS = "smoke-pass";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) { console.error(`smoke-e2e: node >= 22 required (running ${process.version})`); process.exit(2); }
if (!fs.existsSync(CLI)) { console.error(`smoke-e2e: ${CLI} not found — run \`npm run build\` (or pass --dist <package-root>)`); process.exit(2); }

// ---- isolated sandbox ----
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bossmode-smoke-"));
const SB = path.join(WORK, "sb");
const DIR = path.join(SB, ".bossmode");
if (!WORK.startsWith(os.tmpdir()) || !DIR.startsWith(os.tmpdir())) { console.error("smoke-e2e: refusing to run outside tmpdir"); process.exit(2); }
fs.mkdirSync(DIR, { recursive: true });
const env = { ...process.env, HOME: SB, BOSSMODE_DIR: DIR, BOSSMODE_ON_TIMEOUT_MS: "90000" };

const steps = [];
const checks = {};
let failure = null;
const t0 = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function step(name, detail = "") { steps.push({ name, detail, atMs: Date.now() - t0 }); console.log(`  ✓ ${name}${detail ? " — " + detail : ""}`); }
function check(name, value) { checks[name] = value; }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function waitFor(fn, timeoutMs, what) {
  const start = Date.now(); let lastErr;
  while (Date.now() - start < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (err) { lastErr = err; }
    await sleep(400);
  }
  throw new Error(`timeout ${timeoutMs}ms waiting for: ${what}${lastErr ? ` (last error: ${String(lastErr.message || lastErr).slice(0, 200)})` : ""}`);
}
const want = (phase) => !ONLY || ONLY === phase;

// ---- CLI ----
function cli(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [CLI, ...args], { env });
    let out = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; c.kill("SIGKILL"); }, timeoutMs);
    c.on("error", (err) => { clearTimeout(timer); reject(err); });
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.stdin.end();
    c.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`bossmode ${args.join(" ")}: timeout after ${timeoutMs}ms\n${out.slice(-600)}`));
      resolve({ code, out });
    });
  });
}
async function bootDaemon(port, what) {
  const r = await cli(["on", "--port", String(port)]);
  assert(r.code === 0 && r.out.includes("Bossmode started"), `${what}: daemon did not start\n${r.out.slice(-600)}`);
  return r;
}
async function stopDaemon(what) {
  const r = await cli(["off"]);
  assert(r.out.includes("stopped") || r.out.includes("not running"), `${what}: unexpected off output\n${r.out.slice(-400)}`);
  return r;
}
let daemonOn = false;
async function bestEffortOff() { try { await cli(["off"], { timeoutMs: 60000 }); } catch { /* best effort */ } }

// ---- API ----
let token = null;
async function api(method, p, body, { auth = true } = {}) {
  const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(auth && token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: res.status, data };
}

// ---- mock model provider (in-process; openai-completions SSE) ----
let mode = null;
let mockLoopError = null;
const mockLog = [];
let mockServer = null;
let MOCK_PORT = 0;
const mockText = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
function turnView(msgs) {
  let li = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === "user") { li = i; break; } }
  const after = msgs.slice(li + 1);
  const toolMsgs = after.filter((m) => m.role === "tool" || m.role === "tool_result");
  const lastUser = li >= 0 ? mockText(msgs[li].content) : "";
  return { toolCount: toolMsgs.length, lastTool: toolMsgs.length ? mockText(toolMsgs[toolMsgs.length - 1].content) : null, lastUser };
}
function decide(json) {
  const msgs = json.messages || [];
  const head = msgs.map((m) => mockText(m?.content)).join("\n");
  const toolNames = Array.isArray(json.tools) ? json.tools.map((t) => t?.function?.name || t?.name).filter(Boolean) : [];
  const { toolCount, lastTool, lastUser } = turnView(msgs);
  const m = mode;
  const small = { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 };
  mockLog.push({ t: Date.now(), id: m?.id ?? null, kind: m?.kind ?? null, msgs: msgs.length, toolCount, lastUser: lastUser.slice(0, 500), lastTool: lastTool ? lastTool.slice(0, 2500) : null, tools: toolNames });
  if (m?.id) {
    const count = mockLog.reduce((acc, e) => acc + (e.id === m.id ? 1 : 0), 0);
    if (count > 15) mockLoopError = `fixture loop suspected: mode ${m.id} received ${count} requests`;
  }
  if (head.includes("summarization")) return { kind: "text", text: "SMOKE SUMMARY", usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 } };
  if (!toolNames.length && !m) return { kind: "text", text: "noop", usage: small };
  if (!m) return { kind: "text", text: "idle-ack", usage: small };
  if (m.kind === "tool") return toolCount === 0 ? { kind: "call", name: m.tool, args: m.args || {}, usage: small } : { kind: "text", text: `done ${m.id}`, usage: small };
  if (m.kind === "chat") return toolCount === 0 ? { kind: "call", name: "chat_send", args: { to: m.to, message: m.text || `ack ${m.id}` }, usage: small } : { kind: "text", text: `done ${m.id}`, usage: small };
  if (m.kind === "slow") return { kind: "delay", delayMs: m.delayMs || 6000, text: `slow-done ${m.id}`, usage: small };
  return { kind: "text", text: m.text || `ack ${m.id}`, usage: small };
}
function mockSend(res, json, d) {
  const usage = d.usage || { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 };
  try {
    if (json.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = { id: "chatcmpl-smoke", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: json.model || "mock" };
      const chunk = (delta, fr) => res.write("data: " + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: fr }] }) + "\n\n");
      if (d.kind === "call") {
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_smoke_1", type: "function", function: { name: d.name, arguments: "" } }] }, null);
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(d.args) } }] }, null);
        chunk({}, "tool_calls");
      } else {
        chunk({ role: "assistant", content: d.text }, null);
        chunk({}, "stop");
      }
      res.write("data: " + JSON.stringify({ ...base, usage, choices: [] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      const message = d.kind === "call"
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_smoke_1", type: "function", function: { name: d.name, arguments: JSON.stringify(d.args) } }] }
        : { role: "assistant", content: d.text };
      res.end(JSON.stringify({
        id: "chatcmpl-smoke", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: json.model || "mock",
        choices: [{ index: 0, message, finish_reason: d.kind === "call" ? "tool_calls" : "stop" }],
        usage,
      }));
    }
  } catch { /* client aborted — drop */ }
}
function startMock() {
  return new Promise((resolve, reject) => {
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => body += c);
      req.on("end", () => {
        let json = {};
        try { json = JSON.parse(body); } catch { /* ignore */ }
        let d;
        try { d = decide(json); } catch { d = { kind: "text", text: "mock-error" }; }
        if (d.kind === "delay") setTimeout(() => mockSend(res, json, d), d.delayMs);
        else mockSend(res, json, d);
      });
    });
    mockServer.on("error", reject);
    mockServer.listen(0, "127.0.0.1", () => { MOCK_PORT = mockServer.address().port; resolve(); });
  });
}
function mockWait(n0, pred, what, timeout = 120000) {
  return waitFor(() => {
    if (mockLoopError) throw new Error(mockLoopError);
    return mockLog.slice(n0).find(pred);
  }, timeout, what);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---- fixtures ----
let DAEMON_PORT, MID, ROOM_ID, PROFILE_ID;
const M1 = "smoke-m1", ROOM_NAME = "smoke-room";

async function login() {
  const r = await api("POST", "/api/auth/login", { username: USER, password: PASS }, { auth: false });
  assert(r.status === 200 && r.data.token, `login failed: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  token = r.data.token;
}

async function seedProfile() {
  const r = await api("POST", "/api/model-credential-profiles", {
    profileKind: "custom_endpoint",
    name: "Smoke Mock",
    providerSlug: "smoke-mock",
    protocol: "openai-completions",
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    authType: "api_key",
    apiKey: "sk-smoke",
    requestProfile: "standard",
    models: [{ id: "smokemodel", name: "Smoke Mock", contextWindow: 200000, maxTokens: 4096, reasoning: false }],
  });
  assert(r.status === 200 && r.data.id, `credential profile create failed: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  PROFILE_ID = r.data.id;
  const list = await api("GET", "/api/model-credential-profiles");
  assert(list.status === 200, `credential profile list failed: ${list.status}`);
  const items = Array.isArray(list.data) ? list.data : (list.data.profiles || []);
  assert(items.some((p) => p.id === PROFILE_ID), "created profile not visible in GET /api/model-credential-profiles");
  check("profileId", PROFILE_ID);
}

async function createMember() {
  const r = await api("POST", "/api/members", { name: M1, model: `${PROFILE_ID}/smokemodel`, credentialId: PROFILE_ID });
  assert(r.status === 200, `member create failed: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  const m = r.data.member || r.data;
  MID = m.memberId || m.id;
  assert(MID, "member id missing in create response");
  check("memberId", MID);
}

async function createRoom() {
  const r = await api("POST", "/api/rooms", { name: ROOM_NAME, memberIds: [MID], leaderMemberId: MID });
  assert(r.status === 200, `room create failed: ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
  const room = r.data.room || r.data;
  ROOM_ID = room.id;
  assert(ROOM_ID, "room id missing in create response");
  check("roomId", ROOM_ID);
}

async function postMessage(content) {
  const r = await api("POST", `/api/rooms/${ROOM_ID}/messages`, { content });
  assert(r.status === 200, `post message failed: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
}

function roomMessages() {
  return api("GET", `/api/rooms/${ROOM_ID}/messages?limit=100`).then((r) => Array.isArray(r.data) ? r.data : (r.data.messages || []));
}
function senderMatches(m, mid, name) {
  return [m.sender, m.senderMemberId, m.senderId].filter(Boolean).some((v) => v === mid || v === name);
}
async function waitRoomMessage(text, timeout = 45000) {
  return waitFor(async () => (await roomMessages()).find((m) => (m.content || "").includes(text) && senderMatches(m, MID, M1)), timeout, `room message ${text}`);
}
async function memberStatus() {
  const r = await api("GET", "/api/rooms");
  const rooms = Array.isArray(r.data) ? r.data : (r.data.rooms || []);
  const room = rooms.find((x) => x.id === ROOM_ID || x.name === ROOM_NAME);
  return room?.agentStatuses?.[M1];
}

// ---- phases ----
async function phaseTerminal() {
  console.log("[T] terminal 六件套");
  // t1 create — 同时断言「按聊天给的工具面」包含六件套
  let n = mockLog.length;
  mode = { id: "t1", kind: "tool", tool: "terminal_create", args: { name: "smoke-term" } };
  await postMessage(`@${M1} t1`);
  const first = await mockWait(n, (e) => e.id === "t1" && e.toolCount === 0, "t1 first request (tool surface)", 60000);
  const six = ["terminal_create", "terminal_exec", "terminal_read", "terminal_wait", "terminal_list", "terminal_close"];
  const surface = new Set(first.tools || []);
  const missing = six.filter((t) => !surface.has(t));
  check("surfaceTerminalTools", six.filter((t) => surface.has(t)));
  assert(missing.length === 0, `terminal tools missing from chat surface: ${missing.join(", ")}`);
  const e1 = await mockWait(n, (e) => e.id === "t1" && e.lastTool, "t1 tool result");
  const tidMatch = /"terminalId"\s*:\s*"([^"]+)"/.exec(e1.lastTool || "");
  assert(tidMatch, `no terminalId in create result: ${(e1.lastTool || "").slice(0, 200)}`);
  const TID = tidMatch[1];
  check("terminalId", TID);
  step("terminal_create", TID);

  // t2 exec (fast)
  n = mockLog.length;
  mode = { id: "t2", kind: "tool", tool: "terminal_exec", args: { terminalId: TID, command: "echo SMOKE_TERM_OK", blockSeconds: 10 } };
  await postMessage(`@${M1} t2`);
  const e2 = await mockWait(n, (e) => e.id === "t2" && e.lastTool, "t2 exec result");
  assert(/SMOKE_TERM_OK/.test(e2.lastTool) && /"status"\s*:\s*"done"/.test(e2.lastTool) && /"exitCode"\s*:\s*0/.test(e2.lastTool), `exec did not settle clean: ${e2.lastTool.slice(0, 300)}`);
  step("terminal_exec (fast)", "SMOKE_TERM_OK, done/exit 0");

  // t3 exec (slow, non-blocking) → running window
  n = mockLog.length;
  mode = { id: "t3", kind: "tool", tool: "terminal_exec", args: { terminalId: TID, command: "sleep 2; echo LATE_OK", blockSeconds: 0 } };
  await postMessage(`@${M1} t3`);
  const e3 = await mockWait(n, (e) => e.id === "t3" && e.lastTool, "t3 non-blocking exec result");
  assert(/"status"\s*:\s*"running"/.test(e3.lastTool), `expected running, got: ${e3.lastTool.slice(0, 300)}`);
  const execMatch = /"exec"\s*:\s*"(e\d+)"/.exec(e3.lastTool);
  assert(execMatch, `no exec id in running result: ${e3.lastTool.slice(0, 200)}`);
  const EXEC = execMatch[1];
  step("terminal_exec (background)", `${EXEC} running`);

  // t4 wait
  n = mockLog.length;
  mode = { id: "t4", kind: "tool", tool: "terminal_wait", args: { terminalId: TID, exec: EXEC, blockSeconds: 20 } };
  await postMessage(`@${M1} t4`);
  const e4 = await mockWait(n, (e) => e.id === "t4" && e.lastTool, "t4 wait result");
  assert(/"status"\s*:\s*"done"/.test(e4.lastTool) && /LATE_OK/.test(e4.lastTool), `wait did not settle: ${e4.lastTool.slice(0, 300)}`);
  step("terminal_wait", `${EXEC} done, LATE_OK`);

  // t5 read
  n = mockLog.length;
  mode = { id: "t5", kind: "tool", tool: "terminal_read", args: { terminalId: TID, exec: EXEC } };
  await postMessage(`@${M1} t5`);
  const e5 = await mockWait(n, (e) => e.id === "t5" && e.lastTool, "t5 read result");
  assert(/LATE_OK/.test(e5.lastTool) && /"lineStart"/.test(e5.lastTool), `read missing output/lines: ${e5.lastTool.slice(0, 300)}`);
  step("terminal_read", "LATE_OK via line window");

  // t6 list
  n = mockLog.length;
  mode = { id: "t6", kind: "tool", tool: "terminal_list", args: {} };
  await postMessage(`@${M1} t6`);
  const e6 = await mockWait(n, (e) => e.id === "t6" && e.lastTool, "t6 list result");
  assert(/"terminals"/.test(e6.lastTool) && e6.lastTool.includes(TID), `list missing terminal: ${e6.lastTool.slice(0, 300)}`);
  step("terminal_list", "terminal present");

  // t7 close
  n = mockLog.length;
  mode = { id: "t7", kind: "tool", tool: "terminal_close", args: { terminalId: TID } };
  await postMessage(`@${M1} t7`);
  const e7 = await mockWait(n, (e) => e.id === "t7" && e.lastTool, "t7 close result");
  assert(/"ok"\s*:\s*true/.test(e7.lastTool), `close failed: ${e7.lastTool.slice(0, 300)}`);
  step("terminal_close", "closed");
}

async function phaseLifecycle() {
  console.log("[L] 生命周期：回复落回");
  const n = mockLog.length;
  mode = { id: "c1", kind: "chat", to: ROOM_NAME, text: "SMOKE_REPLY_OK" };
  await postMessage(`@${M1} c1`);
  await mockWait(n, (e) => e.id === "c1" && e.toolCount >= 1, "chat_send tool turn");
  const msg = await waitRoomMessage("SMOKE_REPLY_OK");
  check("replyMessageId", msg.id);
  step("chat_send 回复落回房间", msg.id);
}

async function lockStep(name, fn, timeout = 120000) {
  const start = Date.now();
  await fn();
  step(name, `${Date.now() - start}ms`);
}

async function phaseRestart() {
  console.log("[R] 重启：在飞轮次 → off/on → 续跑落账");
  // r1: slow turn truly in flight
  const n = mockLog.length;
  mode = { id: "r1", kind: "slow", delayMs: 8000, text: "slow-done" };
  await postMessage(`@${M1} r1`);
  await mockWait(n, (e) => e.id === "r1" && e.toolCount === 0, "r1 in-flight request", 60000);
  const statusInFlight = await memberStatus();
  check("statusInFlight", statusInFlight);
  assert(statusInFlight === "working", `slow turn not in flight: status=${statusInFlight}`);
  step("在飞确认", `status=${statusInFlight}`);

  await lockStep("CLI off/on（在飞中断）", async () => {
    await stopDaemon("restart off");
    daemonOn = false;
    await bootDaemon(DAEMON_PORT, "restart on");
    daemonOn = true;
  });

  // session files intact
  const sessDir = path.join(DIR, "members", MID, "sessions");
  assert(fs.existsSync(sessDir), `sessions dir missing: ${sessDir}`);
  const walkFiles = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walkFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files1 = walkFiles(sessDir).map((f) => path.relative(sessDir, f));
  check("sessionFiles", files1.slice(0, 20));
  assert(files1.length > 0, "no session files after restart");
  assert(!files1.some((f) => f.startsWith("rooms/") || f.startsWith("dm/")), `legacy session dirs present: ${files1.join(", ")}`);
  step("会话文件在场", `${files1.length} files`);

  // member returns to idle
  const st = await waitFor(async () => { const s = await memberStatus(); return s !== "working" ? s : null; }, 60000, "member idle after restart");
  check("statusAfterRestart", st);
  step("重启后状态", String(st));

  // post-restart turn lands
  const n2 = mockLog.length;
  mode = { id: "r2", kind: "chat", to: ROOM_NAME, text: "SMOKE_AFTER_RESTART" };
  await postMessage(`@${M1} r2`);
  await mockWait(n2, (e) => e.id === "r2" && e.toolCount >= 1, "post-restart turn");
  const msg = await waitRoomMessage("SMOKE_AFTER_RESTART");
  step("重启后续跑落账", msg.id);

  // queue settled（轮询：无 pending/dispatched；被重启取消的在飞轮次以 cancelled/uncertain 收尾）
  const { DatabaseSync } = requireBuiltin("node:sqlite");
  const readGroups = () => {
    const db = new DatabaseSync(path.join(DIR, "bossmode.db"), { readOnly: true });
    try { return db.prepare("SELECT status, COUNT(*) n FROM queued_inputs GROUP BY status").all(); } finally { db.close(); }
  };
  const groups = await waitFor(() => {
    const g = readGroups();
    return g.some((x) => x.status === "pending" || x.status === "dispatched") ? null : g;
  }, 60000, "queue settle (no pending/dispatched)");
  const dbq = new DatabaseSync(path.join(DIR, "bossmode.db"), { readOnly: true });
  const unavailable = dbq.prepare("SELECT COUNT(*) n FROM queued_inputs WHERE diagnosis LIKE '%member unavailable%'").get().n;
  dbq.close();
  check("queueGroups", groups);
  check("queueMemberUnavailable", unavailable);
  assert(unavailable === 0, `queue has member-unavailable rows: ${unavailable}`);
  step("队列落定", groups.map((g) => `${g.status}:${g.n}`).join(" "));
}

// ---- main ----
async function main() {
  console.log(`smoke-e2e: dist=${DIST}`);
  console.log(`workdir=${WORK}`);
  DAEMON_PORT = await freePort();
  await startMock();
  step("mock provider", `port ${MOCK_PORT}`);

  // config（legacy config.json 路径；daemon 首启迁移入 DB）
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${salt}:${createHash("sha256").update(salt + PASS).digest("hex")}`;
  fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify({
    auth: { username: USER, passwordHash },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: DAEMON_PORT },
  }, null, 2));

  await bootDaemon(DAEMON_PORT, "boot1");
  daemonOn = true;
  step("daemon boot1", `:${DAEMON_PORT}`);

  await login();
  step("login");
  await seedProfile();
  step("credential profile", PROFILE_ID);
  await createMember();
  step("member", M1);
  await createRoom();
  step("room", ROOM_NAME);

  if (want("T")) await phaseTerminal();
  if (want("L")) await phaseLifecycle();
  if (want("R")) await phaseRestart();

  await stopDaemon("final off");
  daemonOn = false;
  step("daemon off");
}

let result = { ok: false };
try {
  await main();
  result.ok = true;
} catch (err) {
  failure = err;
  console.error(`\n✗ smoke-e2e FAILED: ${err?.stack || err}`);
} finally {
  try { mockServer?.close(); } catch { /* ignore */ }
  if (daemonOn) await bestEffortOff();
  const verdict = { ok: result.ok, failedAt: steps.length, error: failure ? String(failure.message || failure) : null, steps, checks, workDir: WORK, durationMs: Date.now() - t0, node: process.version, dist: DIST, at: new Date().toISOString() };
  try { fs.writeFileSync(path.join(WORK, "verdict.json"), JSON.stringify(verdict, null, 2)); } catch { /* ignore */ }
  if (!result.ok || KEEP) {
    console.log(`\n现场保留：${WORK} (verdict.json 在内)`);
    if (!result.ok) console.log(`若需清理：rm -rf ${WORK}`);
  } else {
    fs.rmSync(WORK, { recursive: true, force: true });
    console.log(`\nsmoke-e2e PASS（${steps.length} steps, ${Date.now() - t0}ms）`);
  }
}
process.exit(result.ok ? 0 : 1);
