#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { isAbsolute, relative, resolve } from "node:path";

const argv = process.argv.slice(2);
const actions = new Set(["list", "search", "expand"]);
const action = argv.find((value) => actions.has(value));
function option(name) { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; }
function has(name) { return argv.includes(name); }
function fail(message) { console.error(JSON.stringify({ kind: "error", message })); process.exit(1); }
function integer(name, fallback, min, max = 100_000) {
  const raw = option(name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) fail(`${name} must be a finite integer`);
  const value = Number(raw);
  if (value < min || value > max) fail(`${name} must be between ${min} and ${max}`);
  return value;
}

const rootArgument = option("--member-dir");
const limit = integer("--limit", 50, 1);
const maxBytes = integer("--max-bytes", 65_536, 1024, 1_048_576);
if (!action || !rootArgument || !isAbsolute(rootArgument)) fail("Use list, search, or expand with an absolute --member-dir.");
let root;
try { root = realpathSync(rootArgument); } catch { fail("member directory does not exist"); }
if (!/[/\\]members[/\\][^/\\]+$/.test(root)) fail("--member-dir must be a members/<memberId> directory");
const memberId = root.split(/[/\\]/).at(-1);

function safeRelative(file) {
  const value = relative(root, file);
  return value && !value.startsWith("..") && !isAbsolute(value) ? value : null;
}
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor() {
  const raw = option("--cursor");
  if (!raw) return null;
  try { return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { fail("invalid --cursor"); }
}
function scrub(value) {
  const copy = JSON.parse(JSON.stringify(value));
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    delete item.thinkingSignature;
    delete item.encrypted_content;
    Object.values(item).forEach(visit);
  };
  visit(copy);
  return copy;
}
function searchableText(entry) {
  const safe = scrub(entry);
  const content = safe?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : item?.text || "").join("\n");
  return JSON.stringify(safe?.message || safe);
}

const output = { bytes: 0, stopped: false };
function emit(value, reserve = 0) {
  const line = JSON.stringify(value);
  const bytes = Buffer.byteLength(line) + 1;
  if (output.bytes + bytes + reserve > maxBytes) { output.stopped = true; return false; }
  process.stdout.write(`${line}\n`);
  output.bytes += bytes;
  return true;
}
function emitContinuation(cursor, reason, extra = {}) {
  const record = { kind: "truncated", reason, nextCursor: encodeCursor(cursor), ...extra };
  if (!emit(record)) fail("--max-bytes is too small for continuation metadata");
}

async function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found.sort();
}
function scopeFor(file) {
  const parts = safeRelative(file)?.split("/") || [];
  if (parts[0] === "background-tasks") {
    try {
      const task = JSON.parse(readFileSync(resolve(file, "..", "task.json"), "utf8"));
      return typeof task.scopeId === "string" ? task.scopeId : "unknown";
    } catch { return "unknown"; }
  }
  const index = parts.indexOf("sessions");
  const kind = parts[index + 2];
  const id = parts[index + 3];
  if (kind === "rooms") return `room:${id}`;
  if (kind === "topics") return `topic:${id}`;
  if (kind === "dm") return `dm:${memberId}`;
  return "unknown";
}
async function scanFile(file, startLine, onRecord, onDiagnostic) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (lineNumber <= startLine || !line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch {
      if (onDiagnostic(lineNumber) === false) { lines.close(); input.destroy(); break; }
      continue;
    }
    if (onRecord(entry, lineNumber) === false) { lines.close(); input.destroy(); break; }
  }
}

if (action === "expand") {
  const requested = option("--file");
  const entryId = option("--entry");
  if (!requested || !entryId) fail("expand requires --file and --entry");
  let file;
  try { file = await realpath(resolve(root, requested)); } catch { fail("file not found"); }
  if (!safeRelative(file) || !statSync(file).isFile()) fail("file escapes member directory");
  const entries = [];
  await scanFile(file, 0, (entry, line) => { entries.push({ ...entry, _line: line }); }, () => true);
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const anchor = byId.get(entryId);
  if (!anchor) fail("entryId not found");
  const visited = new Set();
  const ancestors = [];
  let current = anchor;
  let missingParent = null;
  while (current) {
    if (visited.has(current.id)) fail(`branch cycle detected at entryId ${current.id}`);
    visited.add(current.id);
    ancestors.unshift(current);
    if (!current.parentId) break;
    const parent = byId.get(current.parentId);
    if (!parent) { missingParent = current.parentId; break; }
    current = parent;
  }
  const before = integer("--before", 3, 0, 1000);
  const after = integer("--after", 3, 0, 1000);
  const records = [
    ...ancestors.slice(-(before + 1)).map((entry) => ({ relation: entry.id === entryId ? "anchor" : "ancestor", entry: scrub(entry) })),
    ...entries.filter((entry) => entry.parentId === entryId).slice(0, after).map((entry) => ({ relation: "direct-child", entry: scrub(entry) })),
  ];
  const cursor = decodeCursor();
  let index = cursor?.action === "expand" && cursor.file === requested && cursor.entryId === entryId ? cursor.index : 0;
  if (!Number.isInteger(index) || index < 0 || index > records.length) fail("invalid expand cursor");
  if (missingParent) emit({ kind: "diagnostic", file: requested, entryId, reason: "missing-parent", parentId: missingParent }, 256);
  for (; index < records.length; index++) {
    if (!emit({ kind: "expand", file: requested, entryId, branch: true, ...records[index] }, 256)) break;
  }
  if (index < records.length) emitContinuation({ action: "expand", file: requested, entryId, index }, "max-bytes");
  process.exit(0);
}

const query = option("--text");
if (action === "search" && !query) fail("search requires --text");
const from = option("--from") ? Date.parse(option("--from")) : -Infinity;
const to = option("--to") ? Date.parse(option("--to")) : Infinity;
if (Number.isNaN(from) || Number.isNaN(to)) fail("--from/--to must be UTC ISO timestamps");
const wantedScope = option("--scope");
const roots = [resolve(root, "sessions")];
if (has("--include-background")) roots.push(resolve(root, "background-tasks"));
const files = (await Promise.all(roots.map(collectFiles))).flat().sort();
const start = decodeCursor();
let count = 0;
let last = start || { file: "", line: 0 };
let diagnostics = 0;
for (const file of files) {
  const relativeFile = safeRelative(file);
  if (start?.file && relativeFile < start.file) continue;
  const scope = scopeFor(file);
  if (wantedScope && scope !== wantedScope) continue;
  const startLine = start?.file === relativeFile ? start.line : 0;
  await scanFile(file, startLine, (entry, line) => {
    const stamp = Date.parse(entry.timestamp || entry.message?.timestamp || "");
    if (action === "list" && (entry.type !== "session" || stamp < from || stamp > to)) return true;
    if (action === "search" && (stamp < from || stamp > to || !searchableText(entry).includes(query))) return true;
    const position = { file: relativeFile, line };
    const record = {
      kind: action, file: relativeFile, scope,
      sessionId: entry.type === "session" ? entry.id : undefined,
      entryId: entry.id, timestamp: entry.timestamp || entry.message?.timestamp,
      role: entry.message?.role, parentId: entry.parentId, toolCallId: entry.toolCallId,
      summary: searchableText(entry).slice(0, 500), branch: Boolean(entry.parentId),
    };
    if (!emit(record, 256)) return false;
    count++;
    last = position;
    return count < limit;
  }, (line) => {
    diagnostics++;
    if (!emit({ kind: "diagnostic", file: relativeFile, line, reason: "invalid-jsonl-record" }, 256)) return false;
    last = { file: relativeFile, line };
    return true;
  });
  if (count >= limit || output.stopped) break;
}
if (count >= limit || output.stopped) emitContinuation(last, output.stopped ? "max-bytes" : "limit", { diagnostics });
