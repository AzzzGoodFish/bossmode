import { syncPath } from "../files/io.js";
import { getBossmodeDir } from "../files/layout.js";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep, posix } from "node:path";
import { getDatabase, type Database } from "../data/database.js";
import { type PrinciplesMeta } from "../kernel/types.js";

export function documentIdentity(path: string, layer: DocumentIdentity["layer"], memberId?: string, scopeId?: string): DocumentIdentity {
  return { path: validateDocumentPath(relative(getBossmodeDir(), path).split(sep).join("/")), layer, memberId,
    scopeId: scopeId?.startsWith("room:") ? scopeId.slice(5) : scopeId };
}

export function readDocumentMeta(identity: DocumentIdentity): PrinciplesMeta | undefined {
  const record = getDocument(getDatabase(), identity.path);
  assertDocumentIdentity(record, identity);
  return record?.meta;
}

/** Reject symlinks at every asset segment, including the current body. */
function assetPath(relativePath: string): string {
  validateDocumentPath(relativePath);
  let path = resolve(getBossmodeDir());
  const parts = relativePath.split("/");
  for (let i = 0; i < parts.length; i++) {
    const parent = path;
    path = join(path, parts[i]);
    if (!existsSync(path)) {
      // lstat also detects dangling symlinks, unlike existsSync.
      try { if (lstatSync(path).isSymbolicLink()) throw new Error(`Document asset is a symlink: ${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (i < parts.length - 1) mkdirSync(path);
    } else {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`Invalid document asset file: ${path}`);
      }
    }
    // Visible directories may survive a failed mkdir/parent-fsync attempt. Re-sync
    // every containing entry on retries, stopping at the existing Bossmode data root.
    if (i < parts.length - 1) syncPath(parent);
  }
  return path;
}

function prepareTemporary(path: string, bytes: Uint8Array): string {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  catch (error) { rmSync(temp, { force: true }); throw error; }
  finally { closeSync(fd); }
  return temp;
}

function replaceBody(path: string, bytes: Uint8Array): void {
  const temp = prepareTemporary(path, bytes);
  try { renameSync(temp, path); syncPath(dirname(path)); }
  finally { rmSync(temp, { force: true }); }
}

function retainSnapshot(path: string, bytes: Buffer): void {
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`Document snapshot content conflict: ${path}`);
    // A previous link may be visible even though its directory fsync failed.
    syncPath(path);
    syncPath(dirname(path));
    return;
  }
  const temp = prepareTemporary(path, bytes);
  try {
    // link is exclusive; never rename over an existing immutable revision.
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(path).equals(bytes)) throw error;
    }
    // Also sync the existing inode when an identical snapshot won the exclusive link.
    syncPath(path);
    syncPath(dirname(path));
  } finally { rmSync(temp, { force: true }); }
}

/** Synchronous file-first write, called outside any enclosing SQL transaction.
 * Snapshots are durable before references commit. On SQL failure restore the old current
 * body when still ours; prepared snapshots may remain unreferenced and are safe to retain.
 * A process crash between rename and commit can leave the current file ahead of metadata;
 * it cannot make a committed historical body unavailable. This is not file/SQL atomicity.
 */
export function saveDocument(identity: DocumentIdentity, content: string,
  actor: { type: "user" | "member"; memberId?: string; name?: string },
  options: { operation: "write" | "edit"; reason: string; eventScopeId?: string }): PrinciplesMeta {
  const db = getDatabase(); // Fail before file preparation if storage or transaction state is unsafe.
  db.assertOutsideTransaction();
  const previous = getDocument(db, identity.path);
  assertDocumentIdentity(previous, identity);
  const expectedRevision = previous?.meta.revision ?? 0;
  const meta: PrinciplesMeta = { revision: expectedRevision + 1, ...documentContentMeta(content), updatedAt: Date.now(),
    updatedBy: actor.type, updatedByMemberId: actor.memberId, updatedByName: actor.name };
  const bytes = Buffer.from(content, "utf8");
  const snapshotPath = documentSnapshotPath(identity.path, meta.contentHash);
  const snapshot = assetPath(snapshotPath);
  retainSnapshot(snapshot, bytes);
  const current = assetPath(identity.path);
  const before = existsSync(current) ? readFileSync(current) : undefined;
  try {
    replaceBody(current, bytes);
    // Never link metadata to a missing/different revision, even if preparation was disturbed.
    if (!readFileSync(snapshot).equals(bytes) || !readFileSync(current).equals(bytes)) throw new Error("Document preparation changed");
    commitDocumentRevision(db, identity, meta, { revision: meta.revision,
      scopeId: options.eventScopeId?.startsWith("room:") ? options.eventScopeId.slice(5) : options.eventScopeId ?? identity.scopeId,
      ts: meta.updatedAt, actorType: actor.type, actorMemberId: actor.memberId, actorName: actor.name,
      operation: options.operation, reason: options.reason, contentHash: meta.contentHash, contentLength: meta.contentLength,
      snapshotPath, snapshotHash: meta.contentHash, snapshotBytes: bytes.length }, expectedRevision);
  } catch (error) {
    try {
      // Do not replace another successful writer's content or revision.
      const now = getDocument(db, identity.path);
      if ((now?.meta.revision ?? 0) === expectedRevision && existsSync(current) && readFileSync(current).equals(bytes)) {
        if (before) replaceBody(current, before);
        else { rmSync(current); syncPath(dirname(current)); }
      }
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "Document save failed; current body restoration also failed");
    }
    throw error;
  }
  return meta;
}

export interface DocumentIdentity {
  /** POSIX path relative to BOSSMODE_DIR, also the stable document key. */
  path: string;
  layer: "persona" | "principles" | "mainline";
  memberId?: string;
  /** Shared scopes key: bare room ID, dm:<id>; absent for global. */
  scopeId?: string;
}

export interface DocumentHistory {
  ordinal: number;
  revision: number;
  scopeId?: string;
  ts?: number;
  actorType?: "user" | "member";
  actorMemberId?: string;
  actorName?: string;
  operation: string;
  reason: string;
  contentHash: string;
  contentLength: number;
  snapshotPath: string;
  snapshotHash: string;
  snapshotBytes: number;
}

export interface DocumentRecord extends DocumentIdentity { meta: PrinciplesMeta }

export function documentContentMeta(content: string): Pick<PrinciplesMeta, "contentHash" | "contentLength"> {
  return { contentHash: createHash("sha256").update(content, "utf8").digest("hex"), contentLength: content.length };
}

/** Asset references never escape the retained body roots or name non-Markdown files. */
export function validateDocumentPath(path: string): string {
  const parts = path.split("/");
  if (!/^(members|rooms|memory|agents)\//.test(path) || !path.endsWith(".md")
    || parts.some(p => !p || p === "." || p === "..") || /[\\\0]/.test(path)) {
    throw new Error(`Invalid document asset path: ${path}`);
  }
  return path;
}

/** Content-addressed, immutable snapshots beside the current document. */
export function documentSnapshotPath(path: string, hash: string): string {
  validateDocumentPath(path);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid snapshot hash");
  return posix.join(posix.dirname(path), "history", posix.basename(path, ".md"), `${hash}.md`);
}

const selectDocument = `SELECT path, layer, member_id AS memberId, scope_id AS scopeId,
 revision, content_hash AS contentHash, content_length AS contentLength,
 updated_at AS updatedAt, updated_by AS updatedBy, updated_by_member_id AS updatedByMemberId,
 updated_by_name AS updatedByName FROM memory_documents WHERE path=?`;

export function getDocument(db: Database, path: string): DocumentRecord | undefined {
  const row = db.get<DocumentIdentity & PrinciplesMeta>(selectDocument, validateDocumentPath(path));
  if (!row) return undefined;
  // SQLite NULL maps to optional public DTO properties, not a fabricated actor.
  const { layer, memberId, scopeId, revision, contentHash, contentLength, updatedAt, updatedBy, updatedByMemberId, updatedByName } = row;
  return { path, layer, memberId: memberId ?? undefined, scopeId: scopeId ?? undefined, meta: {
    revision, contentHash, contentLength, updatedAt: updatedAt ?? undefined,
    updatedBy: updatedBy ?? undefined, updatedByMemberId: updatedByMemberId ?? undefined,
    updatedByName: updatedByName ?? undefined,
  } };
}

export function assertDocumentIdentity(record: DocumentRecord | undefined, identity: DocumentIdentity): void {
  validateDocumentPath(identity.path);
  if (record && (record.layer !== identity.layer || record.memberId !== identity.memberId || record.scopeId !== identity.scopeId)) {
    throw new Error(`Document ownership mismatch: ${identity.path}`);
  }
}

export function listDocumentHistory(db: Database, path: string): DocumentHistory[] {
  return db.all<DocumentHistory>(`SELECT ordinal, revision, scope_id AS scopeId, ts,
    actor_type AS actorType, actor_member_id AS actorMemberId, actor_name AS actorName,
    operation, reason, content_hash AS contentHash, content_length AS contentLength,
    snapshot_path AS snapshotPath, snapshot_hash AS snapshotHash, snapshot_bytes AS snapshotBytes
    FROM memory_document_history WHERE document_path=? ORDER BY ordinal`, validateDocumentPath(path))
    .map(row => ({ ...row, scopeId: row.scopeId ?? undefined, ts: row.ts ?? undefined,
      actorType: row.actorType ?? undefined, actorMemberId: row.actorMemberId ?? undefined, actorName: row.actorName ?? undefined }));
}

/** SQL-only initial ownership for a durably prepared body. The caller includes this strict
 * insert in its creation transaction; birth has no historical revision or invented actor. */
export function insertInitialDocument(db: Database, identity: DocumentIdentity,
  meta: Pick<PrinciplesMeta, "contentHash" | "contentLength">): void {
  validateDocumentPath(identity.path);
  db.run(`INSERT INTO memory_documents (path, layer, member_id, scope_id, revision, content_hash, content_length)
    VALUES (?, ?, ?, ?, 0, ?, ?)`, identity.path, identity.layer, identity.memberId ?? null,
    identity.scopeId ?? null, meta.contentHash, meta.contentLength);
}

function putDocument(db: Database, identity: DocumentIdentity, meta: PrinciplesMeta): void {
  assertDocumentIdentity(getDocument(db, identity.path), identity);
  db.run(`INSERT INTO memory_documents (path, layer, member_id, scope_id, revision, content_hash, content_length,
    updated_at, updated_by, updated_by_member_id, updated_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET revision=excluded.revision, content_hash=excluded.content_hash,
    content_length=excluded.content_length, updated_at=excluded.updated_at, updated_by=excluded.updated_by,
    updated_by_member_id=excluded.updated_by_member_id, updated_by_name=excluded.updated_by_name`,
    identity.path, identity.layer, identity.memberId ?? null, identity.scopeId ?? null,
    meta.revision, meta.contentHash, meta.contentLength, meta.updatedAt ?? null, meta.updatedBy ?? null,
    meta.updatedByMemberId ?? null, meta.updatedByName ?? null);
}

function insertHistory(db: Database, path: string, event: DocumentHistory): void {
  validateDocumentPath(event.snapshotPath);
  db.run(`INSERT INTO memory_document_history (document_path, ordinal, revision, scope_id, ts, actor_type,
    actor_member_id, actor_name, operation, reason, content_hash, content_length, snapshot_path, snapshot_hash, snapshot_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, path, event.ordinal, event.revision,
    event.scopeId ?? null, event.ts ?? null, event.actorType ?? null, event.actorMemberId ?? null, event.actorName ?? null,
    event.operation, event.reason, event.contentHash, event.contentLength, event.snapshotPath, event.snapshotHash, event.snapshotBytes);
}

/** Commit references only AFTER the caller has durably prepared both file bodies. */
export function commitDocumentRevision(db: Database, identity: DocumentIdentity, meta: PrinciplesMeta,
  event: Omit<DocumentHistory, "ordinal">, expectedRevision: number): void {
  db.transaction(tx => {
    const previous = getDocument(tx, identity.path);
    assertDocumentIdentity(previous, identity);
    if ((previous?.meta.revision ?? 0) !== expectedRevision || meta.revision !== expectedRevision + 1) {
      throw new Error("Document revision changed during preparation");
    }
    const ordinal = tx.get<{ n: number }>("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM memory_document_history WHERE document_path=?", identity.path)!.n;
    putDocument(tx, identity, meta);
    insertHistory(tx, identity.path, { ...event, ordinal });
  });
}

export interface DocumentImportContext {
  /** Synchronous parent upgrade hook. Retain exact bytes; reject different existing content.
   * Returns only after bytes are safely staged for cutover. This is NOT the live writer. */
  stageAsset(relativePath: string, bytes: Uint8Array): void;
}

export interface ImportedDocumentHistory {
  revision?: number;
  scopeId?: string;
  ts?: number;
  actorType?: "user" | "member";
  actorMemberId?: string;
  actorName?: string;
  operation?: string;
  reason?: string;
  contentHash?: string;
  contentLength?: number;
  /** Legacy JSONL snapshot, required. Never substitute today's body for missing history. */
  content: string;
}

export interface DocumentImport {
  identity: DocumentIdentity;
  /** Current body read by the startup inventory, never written by this importer. */
  currentContent: string;
  /** The parent identifies the legacy authority explicitly: member-memory used event count;
   * room principles/mainline used metadata files (missing entry meant revision zero). */
  metadataSource: "history" | "file";
  /** File metadata, when present, remains authoritative even if revision differs from event count. */
  meta?: PrinciplesMeta;
  /** Source order is significant. Member-memory revisions were the parsed event count. */
  history: readonly ImportedDocumentHistory[];
}

/** Pure, explicit startup import: no source discovery, reads, binding or initialization.
 * Prepare assets outside SQL, then insert one document atomically. Retry by rebuilding the staging DB;
 * duplicate import is rejected rather than replacing committed history. */
export function importDocument(db: Database, ctx: DocumentImportContext, input: DocumentImport): void {
  validateDocumentPath(input.identity.path);
  if (input.metadataSource !== "file" && input.metadataSource !== "history") throw new Error("Explicit legacy document metadata source is required");
  if (input.metadataSource === "history" && input.meta) throw new Error("History-authoritative documents cannot also import file metadata");
  if (getDocument(db, input.identity.path)) throw new Error(`Document already imported: ${input.identity.path}`);
  const prepared = input.history.map((event, i): DocumentHistory => {
    if (typeof event.content !== "string") throw new Error(`Missing historical document body: ${input.identity.path} event ${i + 1}`);
    const actual = documentContentMeta(event.content);
    const snapshotPath = documentSnapshotPath(input.identity.path, actual.contentHash);
    const bytes = Buffer.from(event.content, "utf8");
    ctx.stageAsset(snapshotPath, bytes);
    return { ordinal: i + 1, revision: event.revision ?? i + 1, scopeId: event.scopeId ?? input.identity.scopeId,
      ts: event.ts, actorType: event.actorType, actorMemberId: event.actorMemberId, actorName: event.actorName,
      operation: event.operation ?? "write", reason: event.reason ?? "", contentHash: event.contentHash ?? actual.contentHash,
      contentLength: event.contentLength ?? actual.contentLength, snapshotPath, snapshotHash: actual.contentHash, snapshotBytes: bytes.length };
  });
  const last = input.history.at(-1);
  const meta = input.metadataSource === "file"
    ? input.meta ?? { revision: 0, ...documentContentMeta(input.currentContent) }
    : { revision: input.history.length, ...documentContentMeta(input.currentContent),
      updatedAt: last?.ts, updatedBy: last?.actorType, updatedByMemberId: last?.actorMemberId, updatedByName: last?.actorName };
  db.transaction(tx => {
    if (getDocument(tx, input.identity.path)) throw new Error(`Document already imported: ${input.identity.path}`);
    putDocument(tx, input.identity, meta);
    for (const event of prepared) insertHistory(tx, input.identity.path, event);
  });
}

/** Persist prepared birth assets and directory entries before committing identity metadata. */
export function syncMemberBirthAssets(path: string): void {
  function tree(path: string): void {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("birth_asset_symlink");
    if (stat.isDirectory()) for (const child of readdirSync(path)) tree(join(path, child));
    syncPath(path);
  }
  tree(path);
  syncPath(dirname(path));
  syncPath(dirname(dirname(path)));
}
