/** DB-backed archive wizard. Legacy/export JSON is accepted only by explicit startup DTO converters. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { PrinciplesMeta } from "../shared/types.js";
import { getMemoryBudget } from "./memory-budgets.js";
import { AssetBudgetError, computeAssetBudget } from "./principles-store.js";
import { parseLegacyMemberPersona } from "../storage/upgrade-member-parser.js";
import { getBossmodeDir } from "../shared/config.js";
import { getDatabase, type Database } from "../storage/database.js";
import { MemberArchivesRepository, validateArchivePath, type ArchiveCatalogSource } from "../storage/repositories/member-archives.js";
import { createMemberWithPersona, type MemberRecord, type MemberGlobalConfig } from "./member-registry.js";
import { checkedAssetPath } from "./member-archive-lifecycle.js";

export interface ArchiveListItem {
  name: string;
  template: string;
  hasPersona: boolean;
  roomScopes: Array<{ room: string; hasPrinciples: boolean; hasMainline: boolean }>;
  archivePath: string;
  credentialHint?: string | null;
  conflicts?: string[];
  kind: "legacy" | "fired";
}
export function listArchives(): ArchiveListItem[] {
  return new MemberArchivesRepository(getDatabase()).list().map(source => ({name:source.name, template:source.template,
    hasPersona:source.hasPersona, roomScopes:source.roomScopes, archivePath:source.archivePath,
    credentialHint:source.global.credentialId ?? null, ...(source.conflicts ? {conflicts:source.conflicts} : {}), kind:source.kind}))
    .sort((a,b) => a.name.localeCompare(b.name));
}

/** Literal persona wins. Only explicitly tagged historical member.md sources strip frontmatter once. */
export function decodeArchivePersona(raw: string, format: "plain" | "frontmatter"): {body:string; title?:string} {
  if (format === "plain") return {body:raw};
  const parsed = parseLegacyMemberPersona(Buffer.from(raw, "utf8"), "archive/member.md");
  return {body:Buffer.from(parsed.body).toString("utf8"), ...(parsed.title !== undefined ? {title:parsed.title} : {})};
}

export interface FiredArchiveSource {
  archivePath: string;
  /** Parsed explicit member.json export; its ID is NOT automatically associated with live SQL identity. */
  member: Pick<MemberRecord, "name" | "agentTemplate" | "global"> & Partial<Pick<MemberRecord, "id" | "title">>;
  persona?: {path:string; format:"plain" | "frontmatter"; hasContent:boolean};
}
/** Pure DTO conversion. Parent reads/validates sources once, then calls repository.importCatalog(). */
export function catalogFromFiredExport(source: FiredArchiveSource): ArchiveCatalogSource {
  validateArchivePath(source.archivePath);
  return {archivePath:source.archivePath, name:source.member.name, template:source.member.agentTemplate || "general",
    title:source.member.title, global:source.member.global ?? {}, personaPath:source.persona?.path,
    personaFormat:source.persona?.format ?? "plain", hasPersona:source.persona?.hasContent ?? false, roomScopes:[], kind:"fired"};
}
export interface LegacyArchiveManifestSource {
  archivePath: string;
  members: Array<{
    name:string; sourceAgent?:string; credentialId?:string; conflicts?:string[];
    rooms?:Array<{room:string; hasPrinciples?:boolean; hasMainline?:boolean}>;
    /** Parent selects a verified body inside this archive, including relocated old principlesPath. */
    personaPath?:string;
    hasPersona?:boolean;
  }>;
}
/** Aggregate historical labels only within one manifest. No current member lookup or ID guessing. */
export function catalogFromLegacyManifest(source: LegacyArchiveManifestSource): ArchiveCatalogSource[] {
  validateArchivePath(source.archivePath);
  const byName = new Map<string, ArchiveCatalogSource>();
  for (const member of source.members) {
    const rooms = (member.rooms ?? []).map(r => ({room:r.room, hasPrinciples:!!r.hasPrinciples, hasMainline:!!r.hasMainline}));
    const previous = byName.get(member.name);
    if (previous) {
      if (previous.personaPath && member.personaPath && previous.personaPath !== member.personaPath) throw new Error("ambiguous_legacy_persona");
      previous.roomScopes.push(...rooms);
      previous.conflicts = [...(previous.conflicts ?? []), ...(member.conflicts ?? [])];
      previous.personaPath ??= member.personaPath;
      previous.hasPersona ||= member.hasPersona ?? !!member.personaPath;
    } else byName.set(member.name, {archivePath:source.archivePath, name:member.name, template:member.sourceAgent || "general",
      global:{credentialId:member.credentialId ?? null}, personaPath:member.personaPath, personaFormat:"plain",
      hasPersona:member.hasPersona ?? !!member.personaPath, roomScopes:rooms, conflicts:member.conflicts, kind:"legacy"});
  }
  return [...byName.values()];
}

/** Structural E commitDocumentRevision input. No E file/SQL implementation is duplicated here. */
export interface PreparedArchivePersona {
  identity: {path:string; layer:"persona"; memberId:string};
  meta: PrinciplesMeta;
  event: {revision:number; ts:number; actorType:"user"; operation:"write"; reason:"importFromArchive";
    contentHash:string; contentLength:number; snapshotPath:string; snapshotHash:string; snapshotBytes:number};
}
export interface ArchiveImportHooks {
  /** SQL-only E adapter; invoked inside the identity/settings transaction after durable file preparation. */
  commitPersona(db: Database, prepared: PreparedArchivePersona): void;
}

/** New identity, no asset cloning/overwriting and no copied historical ID. Omitted config inherits; explicit null clears. */
export function importMemberFromArchive(opts: {
  archivePath: string;
  name: string;
  /** Needed when the new name differs, or several legacy entries share a backup directory. */
  sourceName?: string;
  agentTemplate?: string;
  credentialId?: string | null;
  global?: Partial<MemberGlobalConfig>;
}, hooks?: ArchiveImportHooks): MemberRecord {
  getDatabase().assertOutsideTransaction();
  validateArchivePath(opts.archivePath);
  const repo = new MemberArchivesRepository(getDatabase());
  let source = repo.get(opts.archivePath, opts.sourceName ?? opts.name);
  if (!source && !opts.sourceName) {
    const matches = repo.list().filter(s => s.archivePath === opts.archivePath);
    if (matches.length === 1) source = matches[0];
    else if (matches.length > 1) throw new Error("archive_source_name_required");
  }
  if (!source) throw new Error("archive_not_found");
  const profile = source.personaPath
    ? decodeArchivePersona(readFileSync(checkedAssetPath(getBossmodeDir(), source.personaPath), "utf8"), source.personaFormat)
    : {body:""};
  const needsHistory = !!profile.body.trim();
  if (needsHistory && !hooks) throw new Error("archive_document_integration_required");
  if (hooks?.commitPersona.constructor.name === "AsyncFunction") throw new Error("member_metadata_commit_must_be_synchronous");
  const limit = getMemoryBudget("persona");
  if (profile.body.length > limit) throw new AssetBudgetError({assetLabel:"member persona",
    attemptedLength:profile.body.length, currentContent:"", budget:computeAssetBudget(0, limit)});
  const selected = Object.fromEntries(Object.entries(opts.global ?? {}).filter(([,value]) => value !== undefined));
  const global: MemberGlobalConfig = {...source.global, ...selected};
  if (opts.credentialId !== undefined) global.credentialId = opts.credentialId;
  // Body is installed before the identity/settings transaction. There is no post-commit file writer that can fail.
  return createMemberWithPersona({name:opts.name, agentTemplate:opts.agentTemplate ?? source.template,
    title:source.title ?? profile.title, model:global.model, credentialId:global.credentialId,
    thinkingLevel:global.thinkingLevel, skills:global.skills, mcpServers:global.mcpServers}, profile.body, needsHistory ? record => {
      const contentHash = createHash("sha256").update(profile.body, "utf8").digest("hex");
      const path = `members/${record.id}/persona.md`;
      const snapshotPath = `members/${record.id}/history/persona/${contentHash}.md`;
      const snapshot = join(getBossmodeDir(), snapshotPath);
      mkdirSync(dirname(snapshot), {recursive:true});
      writeFileSync(snapshot, profile.body, {encoding:"utf8", flag:"wx"});
      const prepared: PreparedArchivePersona = {identity:{path,layer:"persona",memberId:record.id},
        meta:{revision:1,contentHash,contentLength:profile.body.length,updatedAt:record.createdAt,updatedBy:"user"},
        event:{revision:1,ts:record.createdAt,actorType:"user",operation:"write",reason:"importFromArchive",
          contentHash,contentLength:profile.body.length,snapshotPath,snapshotHash:contentHash,snapshotBytes:Buffer.byteLength(profile.body,"utf8")}};
      return db => hooks!.commitPersona(db, prepared);
    } : undefined);
}
