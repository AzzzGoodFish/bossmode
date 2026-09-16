import { closeSync, constants, fstatSync, lstatSync, openSync, read, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";

/** Startup-only, read-only source discovery. This module has no application imports.
 * Run under exclusive startup ownership, then read the runner's immutable backup/files
 * root, not the live source. Neither inventory order nor mtime chooses authority.
 */
export type LegacyKind =
  | "config" | "model-credentials" | "catalog-remote" | "catalog-overlays"
  | "mcp-oauth" | "mcp-config" | "mcp-status" | "member-mcp" | "workspaces" | "ssh-private-key" | "ssh-public-key" | "ssh-config"
  | "member-metadata" | "member-profile-mixed" | "agent-template-mixed"
  | "room-metadata" | "topic-metadata" | "tasks" | "messages" | "message-sequence"
  | "member-cursors" | "dm-member-cursor" | "agent-events" | "derived-event-stats"
  | "message-archive" | "message-archive-summary"
  | "current-sessions" | "old-sessions" | "runtime-state" | "user-cursors" | "background-task"
  | "document-body" | "document-meta" | "document-history" | "document-snapshot"
  | "export-snapshot";
export type LegacyFormat = "json" | "jsonl" | "text";
export interface LegacySourceEntry {
  /** Canonical POSIX relative path; structurally compatible with UpgradeSource. */
  path: string;
  retire: boolean;
  kind: LegacyKind;
  format: LegacyFormat;
  mtimeMs: number;
  size: number;
  /** Path provenance only, NOT a verified historical identity or scope existence. */
  scopeId?: string;
  memberId?: string;
  /** Literal event basename or sanitized document owner segment. Never name-resolved. */
  ownerKey?: string;
  layer?: "persona" | "principles" | "mainline";
  documentPath?: string;
  layout?: "member" | "room-memory" | "copy-forward";
  taskId?: string;
  sessionDir?: string;
  slug?: string;
  archiveTimestamp?: string;
  serverKey?: string;
  /** Export snapshots are retained and routed only to the parent's archive catalog. */
  archivePath?: string;
  snapshotKind?: Exclude<LegacyKind, "export-snapshot"> | "archive-manifest";
}
export interface LegacyDiagnostic {
  code: "unknown-metadata";
  path: string;
}
export interface LegacyInventory {
  entries: LegacySourceEntry[];
  diagnostics: LegacyDiagnostic[];
}
export type LegacySourceErrorCode = "invalid-root" | "invalid-path" | "duplicate-path" | "symlink-source"
  | "not-directory" | "not-regular-file" | "unapproved-source" | "wrong-format" | "source-io"
  | "invalid-utf8" | "invalid-json" | "unterminated-jsonl-line";
export class LegacySourceError extends Error {
  constructor(readonly code: LegacySourceErrorCode, readonly path: string, readonly lineNumber?: number) {
    // Do not include native IO/JSON errors or causes: they can contain secret bytes.
    super(`Legacy source ${code}: ${JSON.stringify(path)}${lineNumber === undefined ? "" : `, line ${lineNumber}`}`);
    this.name = "LegacySourceError";
  }
}

type Description = Omit<LegacySourceEntry, "path" | "mtimeMs" | "size">;
type Params = Record<string, string>;
interface Rule { parts: string[]; describe: (p: Params, path: string) => Description }
const tokens: Record<string, RegExp> = {
  member: /^.+$/, room: /^.+$/, topic: /^.+$/, owner: /^.+$/,
  event: /^(.+)\.jsonl$/, archive: /^(?:fired|legacy)-.+$/,
  archiveMessages: /^\d+\.jsonl$/, archiveSummary: /^\d+\.summary\.json$/,
  day: /^\d{4}-\d{2}-\d{2}$/, task: /^bgt-.+$/,
  scope: /^(?:dm|room-.+|topic-.+)$/,
  layerBody: /^(?:principles|mainline)\.md$/,
  layerHistory: /^(?:principles|mainline)-history\.jsonl$/,
  layerMeta: /^(?:principles|mainline)-meta\.json$/,
  oldOwnerBody: /^.+\.md$/, template: /^.+\.md$/,
  snapshotLayer: /^(?:persona|principles|mainline|room-principles)$/,
  hashBody: /^[a-f0-9]{64}\.md$/,
  oauthHash: /^sha256-[a-f0-9]{64}$/,
};
const rules: Rule[] = [];
function rule(pattern: string, describe: Rule["describe"]): void { rules.push({ parts: pattern.split("/"), describe }); }
function description(kind: LegacyKind, format: LegacyFormat = "json", retire = true): Description { return { kind, format, retire }; }
// Topic paths/dirs remain identifiable here so importers can consume them via the
// source-retire flow; topic sources are never imported (fish #19358).
function scope(p: Params): string { return p.topic ? `topic:${p.topic}` : p.room; }
function memberScope(p: Params): string {
  return p.scope === "dm" ? `dm:${p.member}` : p.scope.startsWith("room-") ? p.scope.slice(5) : `topic:${p.scope.slice(6)}`;
}
function layer(file: string): "principles" | "mainline" { return file.startsWith("principles") ? "principles" : "mainline"; }

rule("mcp/runtime/oauth/:oauthHash/tokens.json", p => ({...description("mcp-oauth"),serverKey:p.oauthHash.slice(7)}));

for (const [path, kind] of Object.entries({
  "config.json": "config", "model-credentials.json": "model-credentials",
  "pi-catalog-remote.json": "catalog-remote", "pi-models-store-overlays.json": "catalog-overlays",
  "mcp/mcp.json": "mcp-config", "mcp/status.json": "mcp-status", "user-read-cursors.json": "user-cursors",
  "rooms/runtime-state.json": "runtime-state",
}) as [string, LegacyKind][]) rule(path, () => description(kind));
for (const [file, kind, format, retire] of [
  ["member.json", "member-metadata", "json", true], ["member.md", "member-profile-mixed", "text", true],
  ["mcp.json", "member-mcp", "json", true], ["workspaces.json", "workspaces", "json", true],
  ["ssh/id_ed25519", "ssh-private-key", "text", true], ["ssh/id_ed25519.pub", "ssh-public-key", "text", true],
  ["ssh/config", "ssh-config", "text", true], ["runtime-state.json", "runtime-state", "json", true],
  ["sessions/current.json", "current-sessions", "json", true],
] as const) rule(`members/:member/${file}`, p => ({ ...description(kind, format, retire), memberId: p.member }));
for (const [file, kind, format] of [
  ["dm-messages.jsonl", "messages", "jsonl"], [".dm-seq", "message-sequence", "json"], ["dm-cursor.json", "dm-member-cursor", "json"],
] as const) rule(`members/:member/${file}`, p => ({ ...description(kind, format), memberId: p.member, scopeId: `dm:${p.member}` }));
// Retired background-task layout (fish #19454): recognized and consumed, never imported.
rule("members/:member/background-tasks/:day/:task/task.json", (p, path) => ({
  ...description("background-task"), memberId: p.member, taskId: p.task, sessionDir: path.slice(0, -"/task.json".length),
}));
rule("agents/:template", p => ({ ...description("agent-template-mixed", "text"), slug: p.template.slice(0, -3) }));
rule("rooms/:room/room.json", p => ({ ...description("room-metadata"), scopeId: scope(p) }));
rule("rooms/:room/tasks.json", p => ({ ...description("tasks"), scopeId: scope(p) }));
rule("rooms/:room/runtime-state.json", p => ({ ...description("runtime-state"), scopeId: scope(p) }));
// Retired topic layout (fish #19358): recognized and consumed, never imported.
rule("rooms/:room/topics/:topic/topic.json", p => ({ ...description("topic-metadata"), scopeId: scope(p) }));
for (const base of ["rooms/:room", "rooms/:room/topics/:topic"]) {
  for (const [file, kind, format] of [
    ["messages.jsonl", "messages", "jsonl"], ["cursors.json", "member-cursors", "json"],
    ["sessions.json", "old-sessions", "json"], ["agent-events/.stats.json", "derived-event-stats", "json"],
  ] as const) rule(`${base}/${file}`, p => ({ ...description(kind, format), scopeId: scope(p) }));
  rule(`${base}/${base.includes(":topic") ? ".topic-seq" : ".seq"}`, p => ({ ...description("message-sequence"), scopeId: scope(p) }));
  rule(`${base}/agent-events/:event`, p => ({ ...description("agent-events", "jsonl"), scopeId: scope(p), ownerKey: p.event.slice(0, -6) }));
  rule(`${base}/archives/:archiveMessages`, p => ({ ...description("message-archive", "jsonl"), scopeId: scope(p), archiveTimestamp: p.archiveMessages.split(".")[0] }));
  rule(`${base}/archives/:archiveSummary`, p => ({ ...description("message-archive-summary"), scopeId: scope(p), archiveTimestamp: p.archiveSummary.split(".")[0] }));
}
// Room paths also cover rooms/dm:<id>/agent-events, without turning an event
// basename (even one beginning mem_) into a proven member ID.
rule("members/:member/persona.md", (p, path) => ({ ...description("document-body", "text", false), memberId: p.member, layer: "persona", documentPath: path, layout: "member" }));
rule("members/:member/memory/persona.md", (p, path) => ({ ...description("document-body", "text", false), memberId: p.member, layer: "persona", documentPath: path, layout: "copy-forward" }));
rule("members/:member/memory/persona-history.jsonl", p => ({ ...description("document-history", "jsonl"), memberId: p.member, layer: "persona", documentPath: `members/${p.member}/persona.md`, layout: "member" }));
for (const [token, kind, format, retire] of [
  ["layerBody", "document-body", "text", false], ["layerHistory", "document-history", "jsonl", true],
] as const) rule(`members/:member/memory/scopes/:scope/:${token}`, (p, path) => ({
  ...description(kind, format, retire), memberId: p.member, scopeId: memberScope(p), layer: layer(p[token]),
  documentPath: path.replace(/-history\.jsonl$/, ".md"), layout: "member",
}));
rule("rooms/:room/memory/room-principles.md", (p, path) => ({ ...description("document-body", "text", false), scopeId: scope(p), layer: "principles", documentPath: path, layout: "room-memory" }));
rule("rooms/:room/memory/members/:owner/:layerBody", (p, path) => ({ ...description("document-body", "text", false), scopeId: scope(p), ownerKey: p.owner, layer: layer(p.layerBody), documentPath: path, layout: "room-memory" }));
for (const [token, kind, format] of [["layerMeta", "document-meta", "json"], ["layerHistory", "document-history", "jsonl"]] as const)
  rule(`rooms/:room/memory/:${token}`, p => ({ ...description(kind, format), scopeId: scope(p), layer: layer(p[token]), layout: "room-memory" }));
for (const [dir, docLayer] of [["prompt-supplements", "principles"], ["mainlines", "mainline"]] as const) {
  for (const [file, kind, format, retire] of [
    ["meta.json", "document-meta", "json", true], ["history.jsonl", "document-history", "jsonl", true],
    [":oldOwnerBody", "document-body", "text", false],
  ] as const) rule(`rooms/:room/${dir}/${file === ":oldOwnerBody" ? "members/" : ""}${file}`, (p, path) => ({
    ...description(kind, format, retire), scopeId: scope(p), layer: docLayer, layout: "copy-forward",
    ...(p.oldOwnerBody ? { ownerKey: p.oldOwnerBody.slice(0, -3), documentPath: path } : {}),
  }));
}
rule("rooms/:room/prompt-supplements/room.md", (p, path) => ({ ...description("document-body", "text", false), scopeId: scope(p), layer: "principles", layout: "copy-forward", documentPath: path }));
for (const base of ["members/:member", "members/:member/memory/scopes/:scope", "rooms/:room/memory", "rooms/:room/memory/members/:owner"])
  rule(`${base}/history/:snapshotLayer/:hashBody`, p => ({
    ...description("document-snapshot", "text", false),
    ...(p.member ? { memberId: p.member } : {}), ...(p.owner ? { ownerKey: p.owner } : {}),
    ...(p.scope ? { scopeId: memberScope(p) } : p.room ? { scopeId: scope(p) } : {}),
    layer: p.snapshotLayer === "room-principles" ? "principles" : p.snapshotLayer as "persona" | "principles" | "mainline",
  }));

// Only established fired-/legacy- export layouts. Never recurse through generic
// backups, core-upgrade backups, incident snapshots, or their staged files.
const businessRules = [...rules];
function exported(d: Description, p: Params): Description {
  return { kind: "export-snapshot", format: d.format, retire: false, archivePath: `backups/${p.archive}`, snapshotKind: d.kind as Exclude<LegacyKind, "export-snapshot"> };
}
for (const r of businessRules.filter(r => ["members", "rooms"].includes(r.parts[0]))) {
  rule(`backups/:archive/${r.parts.join("/")}`, (p, path) => exported(r.describe(p, path), p));
  // Fired exports are a member directory copied directly to the export root.
  if (r.parts[0] === "members") rule(`backups/:archive/${r.parts.slice(2).join("/")}`, (p, path) => exported(r.describe(p, path), p));
}
rule("backups/:archive/manifest.json", p => ({ ...description("export-snapshot", "json", false), archivePath: `backups/${p.archive}`, snapshotKind: "archive-manifest" }));

function match(parts: string[], r: Rule): Params | null {
  if (parts.length > r.parts.length) return null;
  const p: Params = {};
  for (let i = 0; i < parts.length; i++) {
    const key = r.parts[i];
    if (key.startsWith(":")) {
      if (!tokens[key.slice(1)].test(parts[i])) return null;
      p[key.slice(1)] = parts[i];
    } else if (key !== parts[i]) return null;
  }
  return p;
}
/** Reject aliases as well as traversal; inventory and runner use the same path key. */
export function validateLegacyPath(path: string): void {
  if (!path || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path)
    || path.split("/").some(p => !p || p === "." || p === "..")) throw new LegacySourceError("invalid-path", path);
}
/** Also usable on a parent-composed source list before snapshot creation. */
export function validateLegacySources(entries: readonly { path: string; retire: boolean }[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    validateLegacyPath(e.path);
    if (seen.has(e.path)) throw new LegacySourceError("duplicate-path", e.path);
    seen.add(e.path);
  }
}
function classify(path: string): Description | undefined {
  const parts = path.split("/");
  const matches = rules.flatMap(r => {
    const p = parts.length === r.parts.length ? match(parts, r) : null;
    return p ? [r.describe(p, path)] : [];
  });
  if (matches.length > 1) throw new LegacySourceError("duplicate-path", path);
  return matches[0];
}
function io<T>(path: string, fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof LegacySourceError) throw e;
    throw new LegacySourceError("source-io", path);
  }
}
function directory(path: string, label: string): void {
  const stat = io(label, () => lstatSync(path));
  if (stat.isSymbolicLink()) throw new LegacySourceError("symlink-source", label);
  if (!stat.isDirectory()) throw new LegacySourceError("not-directory", label);
}
function rootPath(root: string): string {
  if (!isAbsolute(root) || root.includes("\0")) throw new LegacySourceError("invalid-root", "<root>");
  const absolute = resolve(root);
  // Check every ancestor: O_NOFOLLOW on the final file alone is insufficient.
  let current = parse(absolute).root;
  directory(current, "<root>");
  for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    directory(current, "<root>");
  }
  return absolute;
}
function ignoredMetadata(path: string): boolean {
  // SDK bodies can sit directly beside the only approved association/task JSON.
  return /(?:\/sessions\/[^/]+\.jsonl|\/background-tasks\/[^/]+\/[^/]+\/[^/]+\.jsonl)$/.test(path);
}
/** Deterministically sorted files, not a precedence decision. Does not read bodies,
 * referenced SSH keys, JSON metadata, SDK sessions, or arbitrary asset subtrees.
 * Unknown metadata siblings are diagnostic-only, and are never marked for retirement.
 */
export function discoverLegacyInventory(sourceRoot: string): LegacyInventory {
  const root = rootPath(sourceRoot);
  const result: LegacyInventory = { entries: [], diagnostics: [] };
  function visit(relative: string): void {
    const names = io(relative || "<root>", () => readdirSync(join(root, relative))).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      // Staged/temporary artifacts are neither sources nor unknown metadata.
      if (/(?:\.tmp|\.bak|\.partial|\.stage|\.staged|~)$/.test(name)) continue;
      const parts = path.split("/");
      const candidates = rules.filter(r => match(parts, r) !== null);
      if (!candidates.length) {
        if (/\.(?:json|jsonl)$/.test(name) && !ignoredMetadata(path)) result.diagnostics.push({ code: "unknown-metadata", path });
        continue;
      }
      validateLegacyPath(path);
      const stat = io(path, () => lstatSync(join(root, path)));
      if (stat.isSymbolicLink()) throw new LegacySourceError("symlink-source", path);
      const d = classify(path);
      if (d) {
        if (!stat.isFile()) throw new LegacySourceError("not-regular-file", path);
        result.entries.push({ path, ...d, size: stat.size, mtimeMs: stat.mtimeMs });
      } else {
        if (stat.isDirectory()) visit(path);
        else if (candidates.some(r => !r.parts[parts.length - 1].startsWith(":")) || !stat.isFile()) {
          throw new LegacySourceError("not-directory", path);
        } else if (/\.(?:json|jsonl)$/.test(name) && !ignoredMetadata(path)) result.diagnostics.push({ code: "unknown-metadata", path });
      }
    }
  }
  visit("");
  result.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  result.diagnostics.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  validateLegacySources(result.entries);
  return result;
}
function openSource(sourceRoot: string, entry: Pick<LegacySourceEntry, "path">, format: LegacyFormat): number {
  validateLegacyPath(entry.path);
  const d = classify(entry.path);
  if (!d) throw new LegacySourceError("unapproved-source", entry.path);
  if (d.format !== format) throw new LegacySourceError("wrong-format", entry.path);
  const root = rootPath(sourceRoot);
  const parts = entry.path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    directory(current, entry.path);
  }
  const path = join(root, entry.path);
  const stat = io(entry.path, () => lstatSync(path));
  if (stat.isSymbolicLink()) throw new LegacySourceError("symlink-source", entry.path);
  if (!stat.isFile()) throw new LegacySourceError("not-regular-file", entry.path);
  const fd = io(entry.path, () => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    if (!fstatSync(fd).isFile()) throw new LegacySourceError("not-regular-file", entry.path);
    return fd;
  } catch (e) { closeSync(fd); return io(entry.path, () => { throw e; }); }
}
function decode(bytes: Uint8Array, path: string, lineNumber?: number): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new LegacySourceError("invalid-utf8", path, lineNumber); }
}
function json(text: string, path: string, lineNumber?: number): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (e) {
    // V8 reports either a character position or unexpected EOF. Use only its
    // numeric position, never copy the exception text/cause into diagnostics.
    const pos = e instanceof Error ? /\bposition (\d+)\b/.exec(e.message) : null;
    const offset = pos ? Number(pos[1]) : e instanceof Error && e.message === "Unexpected end of JSON input"
      ? text.length : Math.max(0, text.search(/[^\t\r\n ]/));
    const line = lineNumber ?? text.slice(0, offset).split("\n").length;
    throw new LegacySourceError("invalid-json", path, line);
  }
}
/** Strict JSON syntax/UTF-8 only; domain shape/identity validation belongs to parent. */
export function readLegacyJson(sourceRoot: string, entry: Pick<LegacySourceEntry, "path">): unknown {
  const fd = openSource(sourceRoot, entry, "json");
  try { return json(decode(io(entry.path, () => readFileSync(fd)), entry.path), entry.path); }
  finally { closeSync(fd); }
}
export interface LegacyJsonlRecord {
  path: string;
  /** 1-based original nonblank-line ordinal, including non-activity events. */
  ordinal: number;
  /** 1-based physical line, including preceding blank lines. */
  lineNumber: number;
  value: unknown;
}
/** Streaming memory is bounded by the largest line plus a 64 KiB read buffer.
 * Nonblank unterminated tails are never yielded, even when valid JSON. Parent
 * must consume to successful EOF before accepting the import transaction.
 * Early return/throw closes the descriptor; no source is repaired.
 */
export interface InvalidLegacyEventLine {
  path: string; ordinal: number; lineNumber: number; raw: Buffer;
}
export async function* readLegacyJsonl(sourceRoot: string, entry: Pick<LegacySourceEntry, "path">): AsyncGenerator<LegacyJsonlRecord> {
  yield* readJsonl(sourceRoot, entry);
}
/** The old runtime-event reader skipped corrupt JSON. Import retains those exact
 * terminated lines through the callback; all other sources and errors stay strict. */
export async function* readLegacyEventJsonl(sourceRoot: string, entry: LegacySourceEntry, preserveInvalid: (line: InvalidLegacyEventLine) => void): AsyncGenerator<LegacyJsonlRecord> {
  if(entry.kind !== "agent-events") throw new LegacySourceError("wrong-format", entry.path);
  yield* readJsonl(sourceRoot, entry, preserveInvalid);
}
async function* readJsonl(sourceRoot: string, entry: Pick<LegacySourceEntry, "path">, preserveInvalid?: (line: InvalidLegacyEventLine) => void): AsyncGenerator<LegacyJsonlRecord> {
  const fd = openSource(sourceRoot, entry, "jsonl");
  const readChunk = promisify(read);
  let pieces: Buffer[] = [];
  let lineNumber = 1;
  let ordinal = 0;
  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await readChunk(fd, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead);
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        pieces.push(bytes.subarray(start, end));
        const raw = Buffer.concat(pieces);
        const text = decode(raw, entry.path, lineNumber);
        pieces = [];
        if (!/^[\t\r ]*$/.test(text)) {
          ++ordinal;
          let value: unknown; let valid = true;
          try { value = json(text, entry.path, lineNumber); }
          catch(error) {
            if(!preserveInvalid || !(error instanceof LegacySourceError) || error.code !== "invalid-json") throw error;
            preserveInvalid({path: entry.path, ordinal, lineNumber, raw: Buffer.concat([raw, Buffer.from("\n")])});
            valid = false;
          }
          if(valid) yield {path: entry.path, ordinal, lineNumber, value};
        }
        lineNumber++;
        start = end + 1;
      }
      if (start < bytes.length) pieces.push(bytes.subarray(start));
    }
    if (!/^[\t\r ]*$/.test(decode(Buffer.concat(pieces), entry.path, lineNumber))) throw new LegacySourceError("unterminated-jsonl-line", entry.path, lineNumber);
  } catch (e) { if (e instanceof LegacySourceError) throw e; throw new LegacySourceError("source-io", entry.path, lineNumber); }
  finally { closeSync(fd); }
}
