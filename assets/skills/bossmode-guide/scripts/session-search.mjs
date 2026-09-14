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
  const index = parts.indexOf("sessions");
  const kind = parts[index + 2];
  const id = parts[index + 3];
  if (kind === "rooms") return `room:${id}`;
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
  const parseDiagnostics = [];
  await scanFile(file, 0,
    (entry, line) => { entries.push({ ...entry, _line: line }); },
    (line) => { parseDiagnostics.push({ reason: "invalid-jsonl-record", line }); return true; });
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
    ...parseDiagnostics.map((diagnostic) => ({ relation: "diagnostic", diagnostic })),
    ...(missingParent ? [{ relation: "diagnostic", diagnostic: { reason: "missing-parent", parentId: missingParent } }] : []),
    ...ancestors.slice(-(before + 1)).map((entry) => ({ relation: entry.id === entryId ? "anchor" : "ancestor", entry: scrub(entry) })),
    ...entries.filter((entry) => entry.parentId === entryId).slice(0, after).map((entry) => ({ relation: "direct-child", entry: scrub(entry) })),
  ];
  const cursor = decodeCursor();
  if (cursor && (cursor.action !== "expand" || cursor.file !== requested || cursor.entryId !== entryId || !Number.isInteger(cursor.index) || !Number.isInteger(cursor.offset))) fail("invalid expand cursor");
  let index = cursor?.index || 0;
  let offset = cursor?.offset || 0;
  if (index < 0 || index > records.length || offset < 0) fail("invalid expand cursor");
  while (index < records.length) {
    const item = records[index];
    if (item.diagnostic) {
      const next = { action: "expand", file: requested, entryId, index: index + 1, offset: 0 };
      const continuationBytes = Buffer.byteLength(JSON.stringify({ kind: "truncated", reason: "max-bytes", nextCursor: encodeCursor(next) })) + 2;
      if (!emit({ kind: "diagnostic", file: requested, entryId, ...item.diagnostic }, continuationBytes)) break;
      index++; offset = 0; continue;
    }
    const serialized = JSON.stringify(item.entry);
    let chunkLength = Math.min(serialized.length - offset, 2048);
    let emitted = false;
    while (chunkLength > 0) {
      const nextOffset = offset + chunkLength;
      const next = nextOffset < serialized.length
        ? { action: "expand", file: requested, entryId, index, offset: nextOffset }
        : { action: "expand", file: requested, entryId, index: index + 1, offset: 0 };
      const continuationBytes = Buffer.byteLength(JSON.stringify({ kind: "truncated", reason: "max-bytes", nextCursor: encodeCursor(next) })) + 2;
      const row = { kind: "expand", file: requested, entryId, branch: true, relation: item.relation, entryOffset: offset, entryComplete: nextOffset >= serialized.length, entryChunk: serialized.slice(offset, nextOffset) };
      if (emit(row, continuationBytes)) { offset = nextOffset; emitted = true; break; }
      chunkLength = Math.floor(chunkLength / 2);
    }
    if (!emitted) break;
    if (offset >= serialized.length) { index++; offset = 0; }
  }
  if (index < records.length) emitContinuation({ action: "expand", file: requested, entryId, index, offset }, "max-bytes");
  process.exit(0);
}

const query = option("--text");
if (action === "search" && !query) fail("search requires --text");
const from = option("--from") ? Date.parse(option("--from")) : -Infinity;
const to = option("--to") ? Date.parse(option("--to")) : Infinity;
if (Number.isNaN(from) || Number.isNaN(to)) fail("--from/--to must be UTC ISO timestamps");
const wantedScope = option("--scope");
const roots = [resolve(root, "sessions")];
const files = (await Promise.all(roots.map(collectFiles))).flat().sort();
const start = decodeCursor();
if (start && (start.action !== action || typeof start.file !== "string" || !Number.isInteger(start.line) || start.line < 0)) fail("invalid list/search cursor");
let count = 0;
let last = start || { action, file: "", line: 0 };
let diagnostics = 0;
for (const file of files) {
  const relativeFile = safeRelative(file);
  if (start?.file && relativeFile < start.file) continue;
  const scope = scopeFor(file);
  if (wantedScope && scope !== wantedScope) continue;
  const startLine = start?.file === relativeFile ? start.line : 0;
  let fileSessionId;
  try { const header = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]); if (header?.type === "session") fileSessionId = header.id; } catch { /* reported by scan */ }
  await scanFile(file, startLine, (entry, line) => {
    const stamp = Date.parse(entry.timestamp || entry.message?.timestamp || "");
    if (!Number.isFinite(stamp)) {
      diagnostics++;
      const position = { action, file: relativeFile, line };
      const reserve = Buffer.byteLength(JSON.stringify({ kind: "truncated", reason: "max-bytes", nextCursor: encodeCursor(position) })) + 2;
      if (!emit({ kind: "diagnostic", file: relativeFile, line, reason: "invalid-record-timestamp" }, reserve)) return false;
      last = position;
      return true;
    }
    if (action === "list" && (entry.type !== "session" || stamp < from || stamp > to)) return true;
    if (action === "search" && (stamp < from || stamp > to || !searchableText(entry).includes(query))) return true;
    const position = { action, file: relativeFile, line };
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const tool = content.find((item) => item && typeof item === "object" && (item.toolCallId || item.tool_use_id || item.type === "toolCall" || item.type === "tool_use" || item.type === "tool_result"));
    const record = {
      kind: action, file: relativeFile, scope,
      sessionId: entry.type === "session" ? entry.id : fileSessionId,
      entryId: entry.id, timestamp: entry.timestamp || entry.message?.timestamp,
      role: entry.message?.role, parentId: entry.parentId,
      toolCallId: entry.toolCallId || entry.message?.toolCallId || tool?.toolCallId || tool?.tool_use_id || tool?.id,
      summary: searchableText(entry).slice(0, 500), branch: Boolean(entry.parentId),
    };
    const continuation = { kind: "truncated", reason: "max-bytes", nextCursor: encodeCursor(position) };
    const reserve = Buffer.byteLength(JSON.stringify(continuation)) + 2;
    while (record.summary.length > 0 && output.bytes + Buffer.byteLength(JSON.stringify(record)) + 1 + reserve > maxBytes) {
      record.summary = record.summary.slice(0, Math.floor(record.summary.length / 2));
      record.summaryTruncated = true;
    }
    if (!emit(record, reserve)) return false;
    count++;
    last = position;
    return count < limit;
  }, (line) => {
    diagnostics++;
    const position = { action, file: relativeFile, line };
    const reserve = Buffer.byteLength(JSON.stringify({ kind: "truncated", reason: "max-bytes", nextCursor: encodeCursor(position) })) + 2;
    if (!emit({ kind: "diagnostic", file: relativeFile, line, reason: "invalid-jsonl-record" }, reserve)) return false;
    last = position;
    return true;
  });
  if (count >= limit || output.stopped) break;
}
if (count >= limit || output.stopped) emitContinuation(last, output.stopped ? "max-bytes" : "limit", { diagnostics });
