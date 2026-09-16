import type { RuntimeStateEntry, RuntimeStateMap } from "../../member/runtime-state.js";
import type { Database } from "../database.js";
import { assertExecutionMember } from "./execution-identity.js";

interface Row {
  member_id: string; contract_fingerprint: string | null;
  contract_version: number | null; drift_notified: number | null; stale_since: number | null;
}
/** Member-level runtime metadata (① B8 / C3): one checkpoint per member. */
export class RuntimeRepository {
  constructor(private readonly db: Database) {}
  private map(r: Row): RuntimeStateEntry {
    return {
      ...(r.contract_fingerprint === null ? {} : {contractFingerprint: r.contract_fingerprint}),
      ...(r.contract_version === null ? {} : {contractVersion: r.contract_version}),
      ...(r.drift_notified === null ? {} : {driftNotified: r.drift_notified}),
      ...(r.stale_since === null ? {} : {staleMounts: {since: r.stale_since,
        fields: this.db.all<{field: string}>("SELECT field FROM runtime_stale_fields WHERE member_id=? ORDER BY ordinal", r.member_id).map(f => f.field)}}),
    };
  }
  get(memberId: string): RuntimeStateEntry {
    const r = this.db.get<Row>("SELECT * FROM runtime_checkpoints WHERE member_id=?", memberId);
    return r ? this.map(r) : {};
  }
  list(): RuntimeStateMap {
    return Object.fromEntries(this.db.all<Row>("SELECT * FROM runtime_checkpoints")
      .map(r => [r.member_id, this.map(r)]));
  }
  /** Pure import with the source's timestamp (or importer-declared source mtime). */
  importEntry(memberId: string, entry: RuntimeStateEntry, updatedAt: number): void {
    this.db.transaction(tx => {
      assertExecutionMember(tx, memberId);
      tx.run(`INSERT INTO runtime_checkpoints(member_id,contract_fingerprint,contract_version,drift_notified,stale_since,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(member_id) DO UPDATE SET contract_fingerprint=excluded.contract_fingerprint,
        contract_version=excluded.contract_version, drift_notified=excluded.drift_notified, stale_since=excluded.stale_since, updated_at=excluded.updated_at`,
      memberId, entry.contractFingerprint ?? null, entry.contractVersion ?? null, entry.driftNotified ?? null, entry.staleMounts?.since ?? null, updatedAt);
      tx.run("DELETE FROM runtime_stale_fields WHERE member_id=?", memberId);
      [...new Set(entry.staleMounts?.fields ?? [])].forEach((field, i) => {
        tx.run("INSERT INTO runtime_stale_fields(member_id,field,ordinal) VALUES(?,?,?)", memberId, field, i);
      });
    });
  }
  update(memberId: string, change: (current: RuntimeStateEntry) => RuntimeStateEntry | undefined, updatedAt: number): void {
    this.db.transaction(() => {
      const next = change(this.get(memberId));
      if (next) this.importEntry(memberId, next, updatedAt);
    });
  }
  clear(memberId: string): void {
    this.db.run("DELETE FROM runtime_checkpoints WHERE member_id=?", memberId);
  }
}
