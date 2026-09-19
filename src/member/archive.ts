import { syncPath } from "../files/io.js";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { type Database, getDatabase } from "../data/database.js";
import { memberArchivePath, getMember, retireMemberIdentity } from "./identity.js";
import { validateArchivePath } from "../files/layout.js";
import { type MemberGlobalConfig } from "./identity.js";
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
  /** Synchronous membership changes share the identity completion transaction. */
  detachFromConversations(memberId: string, db: Database): void;
}

const inFlight = new WeakMap<Database, Map<string, Promise<{archived:string}>>>();

export class MemberArchiveService {
  constructor(private readonly db: Database, private readonly root: string, private readonly hooks: ArchiveLifecycleHooks) {
    if (!isAbsolute(root)) throw new Error("Archive data root must be absolute");
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
    for(const intent of pendingMemberArchives(this.db))await this.archive(intent.memberId,{confirm:true});
  }
  private async perform(memberId: string): Promise<{archived:string}> {
    this.db.assertOutsideTransaction();
    let intent = readMemberArchiveIntent(memberId, this.db);
    if (intent?.state === "completed") {
      if (memberArchivePath(memberId, this.db) !== intent.archivePath) throw new Error("archive_identity_conflict");
      this.checkLocation(intent, true);
      return {archived:intent.archivePath};
    }
    const member = getMember(memberId, this.db);
    if (!member) throw new Error("member_not_found");
    if (!intent) {
      const sourcePath = `members/${memberId}`;
      const source = checkedAssetPath(this.root, sourcePath);
      const stat = statIfPresent(source);
      if (!stat?.isDirectory()) throw new Error("member_assets_missing");
      intent = {memberId, sourcePath, archivePath:`backups/fired-${memberId}-${randomUUID()}`,
        sourceDevice:String(stat.dev), sourceInode:String(stat.ino), state:"pending", createdAt:Date.now(), completedAt:null};
      // Admission closes durably before the first await. No fs or await in this transaction.
      this.db.transaction(() => beginMemberArchive(intent!, this.db));
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
      const current = getMember(memberId, this.db);
      if (!current) throw new Error("archive_identity_conflict");
      const timestamp = Date.now();
      retireMemberIdentity(memberId, intent!.archivePath, timestamp, this.db);
      importMemberArchiveCatalog({archivePath:intent!.archivePath, memberId, name:current.name, template:current.agentTemplate,
        title:current.title, global:current.global, personaPath:`${intent!.archivePath}/persona.md`, personaFormat:"plain",
        hasPersona:!!persona.trim(), roomScopes:[], kind:"fired"}, this.db);
      this.db.transaction(tx => this.hooks.detachFromConversations(memberId, tx));
      completeMemberArchive(memberId, timestamp, this.db);
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

export interface ArchiveCatalogSource {
  archivePath: string;
  name: string;
  /** Only explicit, verified retained SQL identity. Name-only sources must omit this. */
  memberId?: string;
  kind: "legacy" | "fired";
  template: string;
  title?: string;
  global: MemberGlobalConfig;
  /** Relative to data root, inside archivePath; no filename search at runtime. */
  personaPath?: string;
  personaFormat: "plain" | "frontmatter";
  hasPersona: boolean;
  roomScopes: Array<{ room: string; hasPrinciples: boolean; hasMainline: boolean }>;
  conflicts?: string[];
}

export interface MemberArchiveIntent {
  memberId: string; sourcePath: string; archivePath: string;
  sourceDevice: string; sourceInode: string;
  state: "pending" | "completed"; createdAt: number; completedAt: number | null;
}

export function readMemberArchiveIntent(memberId: string, db: Database = getDatabase()): MemberArchiveIntent | null {
    return db.get<MemberArchiveIntent>(`SELECT member_id AS memberId,source_path AS sourcePath,archive_path AS archivePath,
      source_device AS sourceDevice,source_inode AS sourceInode,state,created_at AS createdAt,completed_at AS completedAt
      FROM member_archive_intents WHERE member_id=?`, memberId) ?? null;
  }

export function pendingMemberArchives(db: Database = getDatabase()): MemberArchiveIntent[] {
    return db.all<{member_id:string}>("SELECT member_id FROM member_archive_intents WHERE state='pending' ORDER BY created_at,member_id")
      .map(r => readMemberArchiveIntent(r.member_id, db)!);
  }

export function beginMemberArchive(intent: Omit<MemberArchiveIntent, "state" | "completedAt">, db: Database = getDatabase()): void {
    validateArchivePath(intent.archivePath);
    if (!/^mem_[a-zA-Z0-9_-]+$/.test(intent.memberId) || intent.sourcePath !== `members/${intent.memberId}` ||
      !/^\d+$/.test(intent.sourceDevice) || !/^\d+$/.test(intent.sourceInode)) throw new Error("invalid_archive_intent");
    db.run(`INSERT INTO member_archive_intents VALUES(?,?,?,?,?,'pending',?,NULL)`,
      intent.memberId, intent.sourcePath, intent.archivePath, intent.sourceDevice, intent.sourceInode, intent.createdAt);
  }

export function completeMemberArchive(memberId: string, timestamp: number, db: Database = getDatabase()): void {
    db.run("UPDATE member_archive_intents SET state='completed',completed_at=? WHERE member_id=? AND state='pending'", timestamp, memberId);
  }

export function importMemberArchiveCatalog(source: ArchiveCatalogSource, db: Database = getDatabase()): void {
    validateArchivePath(source.archivePath);
    if (!source.name || !source.template || !source.global || typeof source.global !== "object" || Array.isArray(source.global)) throw new Error("invalid_archive_catalog");
    if (source.personaPath) {
      validateArchivePath(source.personaPath);
      if (!source.personaPath.startsWith(`${source.archivePath}/`)) throw new Error("archive_persona_outside_root");
    }
    db.transaction(tx => {
      if (source.memberId && !tx.get("SELECT id FROM members WHERE id=? AND archived_at IS NOT NULL AND archive_path=?", source.memberId, source.archivePath)) {
        throw new Error("archive_identity_not_retained");
      }
      tx.run("INSERT INTO member_archives VALUES(?,?,?,?,?,?,?,?,?,?)", source.archivePath, source.name, source.memberId ?? null,
        source.kind, source.template, source.title ?? null, JSON.stringify(source.global), source.personaPath ?? null,
        source.personaFormat, Number(source.hasPersona));
      source.roomScopes.forEach((r,i) => tx.run("INSERT INTO member_archive_rooms VALUES(?,?,?,?,?,?)", source.archivePath, source.name, i, r.room, Number(r.hasPrinciples), Number(r.hasMainline)));
      source.conflicts?.forEach((c,i) => tx.run("INSERT INTO member_archive_conflicts VALUES(?,?,?,?)", source.archivePath, source.name, i, c));
    });
  }
