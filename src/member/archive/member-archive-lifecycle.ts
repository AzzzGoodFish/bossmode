/** Async archive orchestration. Bootstrap and runtime admission/cancellation are caller-owned. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { Database } from "../../data/database.js";
import { MembersRepository } from "../../data/repositories/members.js";
import { MemberArchivesRepository, validateArchivePath, type MemberArchiveIntent } from "../../data/repositories/member-archives.js";
import { ConversationsRepository } from "../../data/repositories/conversations.js";

/** Resolve a logical relative or old absolute member-owned reference, including immutable D/E snapshots.
 * External references stay external; this is relocation, NOT authorization for arbitrary file reads. */
export function resolveMemberArtifactPath(db: Database, root: string, memberId: string, reference: string): string {
  if (!/^mem_[a-zA-Z0-9_-]+$/.test(memberId) || !reference || reference.includes("\0")) throw new Error("invalid_member_artifact_reference");
  const source = resolve(root, "members", memberId);
  const path = isAbsolute(reference) ? resolve(reference) : resolve(source, reference);
  const rel = relative(source, path);
  const owned = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  if (!isAbsolute(reference) && !owned) throw new Error("member_artifact_outside_root");
  const archive = new MembersRepository(db).archivedPath(memberId);
  if (archive) validateArchivePath(archive);
  else if (new MemberArchivesRepository(db).intent(memberId)?.state === "pending") throw new Error("member_archive_pending");
  return owned && archive ? resolve(root, archive, rel) : path;
}

/** E keys are data-root relative, not member-relative. Preserve logical DB keys when opening bodies. */
export function resolveMemberDocumentPath(db: Database, root: string, memberId: string, logicalPath: string): string {
  if (isAbsolute(logicalPath) || logicalPath.includes("\\") || logicalPath.split("/").includes("..")) throw new Error("invalid_document_path");
  return resolveMemberArtifactPath(db, root, memberId, resolve(root, logicalPath));
}

function statIfPresent(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (err: any) { if (err.code === "ENOENT") return null; throw err; }
}
/** Caller-selected data root; reject symlinks on path segments instead of following archive metadata. */
export function checkedAssetPath(root: string, relativePath: string): string {
  const base = resolve(root);
  const full = resolve(base, relativePath);
  const rel = relative(base, full);
  if (isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("\0") ||
    rel === ".." || rel.startsWith(`..${sep}`) || relativePath.split("/").includes("..")) throw new Error("invalid_asset_path");
  let current = base;
  for (const segment of ["", ...rel.split(sep)]) {
    if (segment) current = join(current, segment);
    if (statIfPresent(current)?.isSymbolicLink()) throw new Error("archive_symlink_conflict");
  }
  return full;
}
function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function syncTree(path: string): void {
  const stat = lstatSync(path);
  // Retain symlink assets without following them into unrelated workspaces.
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) for (const child of readdirSync(path)) syncTree(join(path, child));
  if (stat.isDirectory() || stat.isFile()) syncPath(path);
}
export interface ArchiveLifecycleHooks {
  /** Must stop live room/DM executions, builders, shells and private tasks, and await release of assets. */
  quiesce(memberId: string): Promise<void>;
}
const inFlight = new WeakMap<Database, Map<string, Promise<{archived:string}>>>();
export class MemberArchiveService {
  private readonly members: MembersRepository;
  private readonly archives: MemberArchivesRepository;
  constructor(private readonly db: Database, private readonly root: string, private readonly hooks: ArchiveLifecycleHooks) {
    if (!isAbsolute(root)) throw new Error("Archive data root must be absolute");
    this.members = new MembersRepository(db);
    this.archives = new MemberArchivesRepository(db);
  }
  pending(): MemberArchiveIntent[] { return this.archives.pending(); }
  admission(memberId: string): "active" | "pending" | "archived" | "missing" {
    if (this.members.archivedPath(memberId)) return "archived";
    if (this.archives.intent(memberId)?.state === "pending") return "pending";
    return this.members.get(memberId) ? "active" : "missing";
  }
  assertAdmission(memberId: string): void {
    const state = this.admission(memberId);
    if (state !== "active") throw new Error(`member_admission_${state}`);
  }
  archive(memberId: string, opts: {confirm?: boolean}): Promise<{archived:string}> {
    this.db.assertOutsideTransaction();
    if (!opts.confirm) return Promise.reject(new Error("confirm_required"));
    let flights = inFlight.get(this.db);
    if (!flights) { flights = new Map(); inFlight.set(this.db, flights); }
    const existing = flights.get(memberId);
    if (existing) return existing;
    const operation = this.perform(memberId).finally(() => flights!.delete(memberId));
    flights.set(memberId, operation);
    return operation;
  }
  /** Call before consumers/admission start. Does not guess identity, cancel tasks itself or replay execution. */
  async recoverPending(): Promise<void> {
    this.db.assertOutsideTransaction();
    for (const intent of this.pending()) await this.archive(intent.memberId, {confirm:true});
  }
  private async perform(memberId: string): Promise<{archived:string}> {
    this.db.assertOutsideTransaction();
    let intent = this.archives.intent(memberId);
    if (intent?.state === "completed") {
      if (this.members.archivedPath(memberId) !== intent.archivePath) throw new Error("archive_identity_conflict");
      this.checkLocation(intent, true);
      return {archived:intent.archivePath};
    }
    const member = this.members.get(memberId);
    if (!member) throw new Error("member_not_found");
    if (!intent) {
      const sourcePath = `members/${memberId}`;
      const source = checkedAssetPath(this.root, sourcePath);
      const stat = statIfPresent(source);
      if (!stat?.isDirectory()) throw new Error("member_assets_missing");
      intent = {memberId, sourcePath, archivePath:`backups/fired-${memberId}-${randomUUID()}`,
        sourceDevice:String(stat.dev), sourceInode:String(stat.ino), state:"pending", createdAt:Date.now(), completedAt:null};
      // Admission closes durably before the first await. No fs or await in this transaction.
      this.db.transaction(() => this.archives.begin(intent!));
    }
    await this.hooks.quiesce(memberId);
    this.db.assertOutsideTransaction();
    const location = this.checkLocation(intent, false);
    const source = checkedAssetPath(this.root, intent.sourcePath);
    const destination = checkedAssetPath(this.root, intent.archivePath);
    const personaPath = checkedAssetPath(this.root, `${location === "source" ? intent.sourcePath : intent.archivePath}/persona.md`);
    const persona = readFileSync(personaPath, "utf8");
    // Quiescence is complete. Retained SDK/persona bytes are synced, never rewritten.
    syncTree(location === "source" ? source : destination);
    mkdirSync(dirname(destination), {recursive:true});
    syncPath(dirname(destination));
    syncPath(this.root);
    if (location === "source") {
      this.checkLocation(intent, false);
      renameSync(source, destination);
    }
    // Also sync visible destinations on retry after a failed fsync, before publishing SQL completion.
    syncPath(destination);
    syncPath(dirname(destination));
    syncPath(dirname(source));
    syncPath(this.root);
    this.db.transaction(() => {
      const current = this.members.get(memberId);
      if (!current) throw new Error("archive_identity_conflict");
      const timestamp = Date.now();
      this.members.archive(memberId, intent!.archivePath, timestamp);
      this.archives.importCatalog({archivePath:intent!.archivePath, memberId, name:current.name, template:current.agentTemplate,
        title:current.title, global:current.global, personaPath:`${intent!.archivePath}/persona.md`, personaFormat:"plain",
        hasPersona:!!persona.trim(), roomScopes:[], kind:"fired"});
      // B owns room persistence. Preserve all labels/local historical records and unrelated room fields.
      const conversations = new ConversationsRepository(this.db);
      for (const room of conversations.listRooms()) {
        // Global rosters treat local records as historical shadows. In a still-local roster,
        // detach only records explicitly linked by ID, never a matching display label.
        const localIds = new Set(room.globalMemberIds === undefined
          ? (room.roomMembers ?? []).filter(m => m.id === memberId || m.sourceMemberId === memberId).map(m => m.id)
          : []);
        const isLeader = room.promptLeaderMemberId === memberId || (room.promptLeaderMemberId !== undefined && localIds.has(room.promptLeaderMemberId));
        if (!room.globalMemberIds?.includes(memberId) && !localIds.size && !isLeader && room.promptLeaderGlobalMemberId !== memberId) continue;
        if (room.globalMemberIds) room.globalMemberIds = room.globalMemberIds.filter(id => id !== memberId);
        else if (localIds.size) room.roomMembers = room.roomMembers!.filter(m => !localIds.has(m.id));
        if (isLeader) delete room.promptLeaderMemberId;
        if (room.promptLeaderGlobalMemberId === memberId) delete room.promptLeaderGlobalMemberId;
        conversations.upsertRoom(room);
      }
      this.archives.complete(memberId, timestamp);
    });
    return {archived:intent.archivePath};
  }
  private checkLocation(intent: MemberArchiveIntent, completed: boolean): "source" | "destination" {
    validateArchivePath(intent.archivePath);
    if (intent.sourcePath !== `members/${intent.memberId}`) throw new Error("archive_source_conflict");
    const source = statIfPresent(checkedAssetPath(this.root, intent.sourcePath));
    const dest = statIfPresent(checkedAssetPath(this.root, intent.archivePath));
    if ((source && dest) || (!source && !dest) || (completed && source)) throw new Error("archive_asset_conflict");
    const stat = (source ?? dest)!;
    if (!stat.isDirectory() || String(stat.dev) !== intent.sourceDevice || String(stat.ino) !== intent.sourceInode) throw new Error("archive_source_identity_conflict");
    return source ? "source" : "destination";
  }
}
