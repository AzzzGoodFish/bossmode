import { getDatabase, type Database } from "../data/database.js";
import { newMemberId } from "../kernel/ids.js";
import { validateArchivePath } from "../files/layout.js";
export interface MemberGlobalConfig { model?:string|null;credentialId?:string|null;thinkingLevel?:string|null;skills?:string[];mcpServers?:string[]; }
export interface MemberRecord { id:string;name:string;title?:string;agentTemplate:string;global:MemberGlobalConfig;createdAt:number;updatedAt:number; }
export interface CreateMemberInput {
  name?: string; title?: string; agentTemplate?: string;
  model?: string | null; credentialId?: string | null; thinkingLevel?: string | null;
  skills?: string[]; mcpServers?: string[];
}
export class MemberNameTakenError extends Error {
  readonly code = "name_taken";
  constructor(name: string) { super(`Member name already taken: ${name}`); this.name = "MemberNameTakenError"; }
}
export class MemberNotFoundError extends Error {
  readonly code = "not_found";
  constructor(id: string) { super(`Member not found: ${id}`); this.name = "MemberNotFoundError"; }
}
interface MemberRow {
  id: string; name: string; title: string | null; agent_template: string;
  global_json: string; created_at: number; updated_at: number;
}
function decodeMember(row: MemberRow): MemberRecord {
  const global = JSON.parse(row.global_json);
  if (!global || typeof global !== "object" || Array.isArray(global)) throw new Error(`Invalid member configuration: ${row.id}`);
  return { id: row.id, name: row.name, ...(row.title ? { title: row.title } : {}),
    agentTemplate: row.agent_template, global, createdAt: row.created_at, updatedAt: row.updated_at };
}
function encodeConfig(config:MemberGlobalConfig):string{return JSON.stringify(config);}
export function normalizeMemberName(name: unknown): string { return String(name ?? "").trim(); }
export function validateMemberName(name: string): void {
  if (!name || name.length > 64 || /[/\0]/.test(name)) throw new Error("invalid_member_name");
  if (["all", "user", "system"].includes(name.toLowerCase())) throw new Error("reserved_member_name");
}
function memberWrite(name: string, write: () => void): void {
  try { write(); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint failed: members.name_key")) throw new MemberNameTakenError(name);
    throw error;
  }
}
export function getMember(id: string, db: Database = getDatabase()): MemberRecord | null {
  const row = db.get<MemberRow>("SELECT * FROM members WHERE id=? AND archived_at IS NULL", id);
  return row ? decodeMember(row) : null;
}
export function requireMember(id: string, db: Database = getDatabase()): MemberRecord {
  const member = getMember(id, db);
  if (!member) throw new MemberNotFoundError(id);
  return member;
}
export function getRetainedMember(id: string, db: Database = getDatabase()): MemberRecord | null {
  const row = db.get<MemberRow>("SELECT * FROM members WHERE id=?", id);
  return row ? decodeMember(row) : null;
}
export function listMembers(db: Database = getDatabase()): MemberRecord[] {
  return db.all<MemberRow>("SELECT * FROM members WHERE archived_at IS NULL").map(decodeMember).sort((a, b) => a.name.localeCompare(b.name));
}
export function findMemberByName(name: string, db: Database = getDatabase()): MemberRecord | null {
  const key = normalizeMemberName(name).toLowerCase();
  const row = key ? db.get<MemberRow>("SELECT * FROM members WHERE name_key=? AND archived_at IS NULL", key) : undefined;
  return row ? decodeMember(row) : null;
}
export function resolveMemberRef(ref: string): MemberRecord | null {
  return ref ? (ref.startsWith("mem_") ? getMember(ref) : findMemberByName(ref)) : null;
}
export function allocateUniqueMemberName(base = "New Member"): string {
  const name = normalizeMemberName(base) || "New Member";
  for (let index = 1; index < 10000; index++) {
    const candidate = index === 1 ? name : `${name} ${index}`;
    if (!findMemberByName(candidate)) return candidate;
  }
  throw new Error("could not allocate unique member name");
}
/** Prepare identity only. The application coordinates assets, settings and the user DM. */
export function prepareMemberIdentity(input: CreateMemberInput): MemberRecord {
  const name = normalizeMemberName(input.name) || allocateUniqueMemberName();
  validateMemberName(name);
  if (findMemberByName(name)) throw new MemberNameTakenError(name);
  let id = newMemberId();
  for (let attempt = 0; attempt < 10 && getRetainedMember(id); attempt++) id = newMemberId();
  const now = Date.now();
  return { id, name, ...(input.title?.trim() ? { title: input.title.trim() } : {}), agentTemplate: input.agentTemplate || "general",
    global: { model: input.model ?? null, credentialId: input.credentialId ?? null, thinkingLevel: input.thinkingLevel ?? null,
      skills: input.skills ?? [], mcpServers: input.mcpServers ?? [] }, createdAt: now, updatedAt: now };
}
/** Strict SQL insertion of a normalized record. No file creation or cross-domain side effects. */
export function insertMemberIdentity(record: MemberRecord, db: Database = getDatabase()): void {
  memberWrite(record.name, () => db.run("INSERT INTO members(id,name,name_key,title,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    record.id, record.name, record.name.toLowerCase(), record.title || null, record.agentTemplate,
    encodeConfig(record.global), record.createdAt, record.updatedAt));
}
export function importArchivedMember(record: MemberRecord, path: string, timestamp: number, db: Database = getDatabase()): void {
  validateArchivePath(path);
  if (!Number.isSafeInteger(timestamp)) throw new Error("invalid_archive_timestamp");
  db.run(`INSERT INTO members(id,name,name_key,title,agent_template,global_json,created_at,updated_at,archived_at,archive_path)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, record.id, record.name, record.name.toLowerCase(), record.title || null,
    record.agentTemplate, encodeConfig(record.global), record.createdAt, record.updatedAt, timestamp, path);
}
export function storeMemberIdentity(record: MemberRecord, db: Database = getDatabase()): void {
  memberWrite(record.name, () => db.run("UPDATE members SET name=?,name_key=?,title=?,agent_template=?,global_json=?,created_at=?,updated_at=? WHERE id=? AND archived_at IS NULL",
    record.name, record.name.toLowerCase(), record.title || null, record.agentTemplate,
    encodeConfig(record.global), record.createdAt, record.updatedAt, record.id));
}
export function memberArchivePath(id: string, db: Database = getDatabase()): string | null {
  return db.get<{ archive_path: string | null }>("SELECT archive_path FROM members WHERE id=?", id)?.archive_path ?? null;
}
export function retireMemberIdentity(id: string, path: string, timestamp: number, db: Database = getDatabase()): void {
  validateArchivePath(path);
  if (!Number.isSafeInteger(timestamp)) throw new Error("invalid_archive_timestamp");
  db.run("UPDATE members SET archived_at=?,archive_path=? WHERE id=? AND archived_at IS NULL", timestamp, path, id);
}
const memberChangeListeners=new Set<(member:MemberRecord)=>void>();
export function onMemberIdentityChanged(listener:(member:MemberRecord)=>void):()=>void{memberChangeListeners.add(listener);return()=>memberChangeListeners.delete(listener);}
export function updateMember(id:string,patch:{name?:string;title?:string|null;global?:Partial<MemberGlobalConfig>}):MemberRecord{
  return getDatabase().transaction(db=>{
    const member=requireMember(id,db),name=patch.name===undefined?member.name:normalizeMemberName(patch.name);
    if(patch.name!==undefined){if(typeof patch.name!=="string")throw new Error("invalid_member_name");validateMemberName(name);}
    if(patch.title!==undefined&&patch.title!==null&&typeof patch.title!=="string")throw new Error("invalid_member_title");
    const title=patch.title===undefined?member.title:patch.title?.trim()||undefined,global={...member.global,...patch.global};
    if(name===member.name&&title===member.title&&encodeConfig(global)===encodeConfig(member.global))return member;
    const next={...member,name,title,global,updatedAt:Date.now()};storeMemberIdentity(next,db);
    if(name!==member.name||title!==member.title)db.afterCommit(()=>{for(const listener of memberChangeListeners)try{listener(next);}catch{}});
    return next;
  });
}
export function getMemberConfiguration(id: string): MemberGlobalConfig {
  const config = requireMember(id).global;
  return { model: config.model ?? null, credentialId: config.credentialId ?? null, thinkingLevel: config.thinkingLevel ?? null,
    skills: config.skills ?? [], mcpServers: config.mcpServers ?? [] };
}

/** Current identity projection without reading runtime configuration. */
export function readMemberIdentity(id: string, retained = false): { id: string; name: string; agentTemplate: string; createdAt: number; updatedAt: number } | null {
  const row = getDatabase().get<{ id: string; name: string; agent_template: string; created_at: number; updated_at: number }>(
    `SELECT id,name,agent_template,created_at,updated_at FROM members WHERE id=?${retained ? "" : " AND archived_at IS NULL"}`, id);
  return row ? { id: row.id, name: row.name, agentTemplate: row.agent_template, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
