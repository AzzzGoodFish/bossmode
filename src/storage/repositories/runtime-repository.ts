import type { RuntimeStateEntry, RuntimeStateMap } from "../../workspace/runtime-state.js";
import type { Database } from "../database.js";
import { assertExecutionOwner, executionScopeId } from "./execution-identity.js";

interface Row {
  scope_id: string; member_id: string; contract_fingerprint: string | null;
  contract_version: number | null; drift_notified: number | null; stale_since: number | null;
}
export class RuntimeRepository {
  constructor(private readonly db: Database) {}
  private map(r: Row): RuntimeStateEntry {
    return {
      ...(r.contract_fingerprint === null ? {} : {contractFingerprint: r.contract_fingerprint}),
      ...(r.contract_version === null ? {} : {contractVersion: r.contract_version}),
      ...(r.drift_notified === null ? {} : {driftNotified: r.drift_notified}),
      ...(r.stale_since === null ? {} : {staleMounts: {since: r.stale_since,
        fields: this.db.all<{field: string}>("SELECT field FROM runtime_stale_fields WHERE scope_id=? AND member_id=? ORDER BY ordinal", r.scope_id, r.member_id).map(f => f.field)}}),
    };
  }
  get(scope: string, memberId: string): RuntimeStateEntry {
    const r = this.db.get<Row>("SELECT * FROM runtime_checkpoints WHERE scope_id=? AND member_id=?", executionScopeId(scope), memberId);
    return r ? this.map(r) : {};
  }
  list(scope: string): RuntimeStateMap {
    const scopeId = executionScopeId(scope);
    const apiScope = scopeId.includes(":") ? scopeId : `room:${scopeId}`;
    return Object.fromEntries(this.db.all<Row>("SELECT * FROM runtime_checkpoints WHERE scope_id=?", scopeId)
      .map(r => [`${apiScope}:${r.member_id}`, this.map(r)]));
  }
  /** Pure import with the source's timestamp (or importer-declared source mtime). */
  importEntry(scope: string, memberId: string, entry: RuntimeStateEntry, updatedAt: number): void {
    this.db.transaction(tx => {
      const scopeId = assertExecutionOwner(tx, memberId, scope);
      tx.run(`INSERT INTO runtime_checkpoints(scope_id,member_id,contract_fingerprint,contract_version,drift_notified,stale_since,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_id,member_id) DO UPDATE SET contract_fingerprint=excluded.contract_fingerprint,
        contract_version=excluded.contract_version,drift_notified=excluded.drift_notified,stale_since=excluded.stale_since,updated_at=excluded.updated_at`,
      scopeId, memberId, entry.contractFingerprint ?? null, entry.contractVersion ?? null, entry.driftNotified ?? null, entry.staleMounts?.since ?? null, updatedAt);
      tx.run("DELETE FROM runtime_stale_fields WHERE scope_id=? AND member_id=?", scopeId, memberId);
      [...new Set(entry.staleMounts?.fields ?? [])].forEach((field, i) => {
        tx.run("INSERT INTO runtime_stale_fields(scope_id,member_id,field,ordinal) VALUES(?,?,?,?)", scopeId, memberId, field, i);
      });
    });
  }
  update(scope: string, memberId: string, change: (current: RuntimeStateEntry) => RuntimeStateEntry | undefined, updatedAt: number): void {
    this.db.transaction(() => {
      const next = change(this.get(scope, memberId));
      if (next) this.importEntry(scope, memberId, next, updatedAt);
    });
  }
  clear(scope: string, memberId: string): void {
    this.db.run("DELETE FROM runtime_checkpoints WHERE scope_id=? AND member_id=?", executionScopeId(scope), memberId);
  }
}
