// File preparation for DB-owned document metadata. No legacy metadata/history IO.
import { syncPath } from "../../files/io.js";
import { getBossmodeDir } from "../../files/layout.js";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

import { getDatabase } from "../../data/database.js";
import { assertDocumentIdentity, commitDocumentRevision, documentContentMeta, documentSnapshotPath, getDocument, validateDocumentPath,
  type DocumentIdentity } from "../../data/repositories/document-repository.js";
import type { PrinciplesMeta } from "../../kernel/types.js";

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
  const db = getDatabase(); // Must fail before any preparation if bootstrap is absent.
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
