/** Archive catalog DTO conversion. The member-import feature was retired (fish 2026-09-11);
 * the archive side (fire flow + startup cataloging) stays. This module performs no file IO. */
import type { MemberRecord } from "../types.js";
import { validateArchivePath, type ArchiveCatalogSource } from "../repositories/member-archives.js";

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
