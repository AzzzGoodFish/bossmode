import type { Database } from "../database.js";
import { parseMmScopeId } from "../../chat/conversations.js";

/** Shared DB keys use bare room IDs. API session/runtime keys also accept room:<id>.
 * Topic scopes were retired (fish #19358) and are no longer accepted here. */
export function executionScopeId(scope: string): string {
  const key = scope.startsWith("room:") ? scope.slice(5) : scope;
  if (!key || (scope.startsWith("room:") && key.includes(":")) ||
    !/^(?:dm:|mm:)?[^/:\\\0]+$/.test(key) || [".", ".."].includes(key.split(":").at(-1)!)) {
    throw new Error(`Invalid execution scope: ${scope}`);
  }
  return key;
}

/** Member-only identity check for member-level state (sessions, status). */
export function assertExecutionMember(db: Database, memberId: string): string {
  if (!memberId || [".", ".."].includes(memberId) || /[/\\:\0]/.test(memberId) || !db.get("SELECT id FROM members WHERE id=?", memberId)) {
    throw new Error(`Unknown execution member ID: ${memberId}`);
  }
  return memberId;
}

/** Exact stable-ID lookup only. Never turn a legacy display name into a current owner. */
export function assertExecutionOwner(db: Database, memberId: string, scopeValue: string): string {
  assertExecutionMember(db, memberId);
  const scopeId = executionScopeId(scopeValue);
  const scope = db.get<{kind: string; member_id: string | null}>("SELECT kind,member_id FROM scopes WHERE id=?", scopeId);
  if (!scope) throw new Error(`scope_not_found: ${scopeValue}`);
  if (scope.kind === "dm" && scope.member_id !== memberId) throw new Error(`DM scope does not belong to member ${memberId}`);
  if (scope.kind === "mm") {
    const pair = parseMmScopeId(scopeId);
    if (!pair || !pair.includes(memberId)) throw new Error(`Member chat scope does not include member ${memberId}`);
  }
  return scopeId;
}

/** Import quarantine only: these records are never returned by runtime getters. */
export function importExecutionAmbiguity(db: Database, entry: {
  sourcePath: string; sourceKey: string; domain: "session" | "runtime" | "cursor";
  reason: string; recordJson: string; importedAt: number;
}): void {
  JSON.parse(entry.recordJson);
  db.run(`INSERT INTO execution_import_ambiguities(source_path,source_key,domain,reason,record_json,imported_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(source_path,source_key,domain) DO UPDATE SET
    reason=excluded.reason,record_json=excluded.record_json,imported_at=excluded.imported_at`,
  entry.sourcePath, entry.sourceKey, entry.domain, entry.reason, entry.recordJson, entry.importedAt);
}
