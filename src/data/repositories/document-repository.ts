import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Database } from "./database.js";
import type { PrinciplesMeta } from "../kernel/types.js";

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
