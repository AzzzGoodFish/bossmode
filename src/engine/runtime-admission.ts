import { getDatabase } from "../data/database.js";
let stopping = false;
export function openRuntimeAdmission(): void { stopping = false; }
export function closeRuntimeAdmission(): void { stopping = true; }
export function runtimeIsStopping(): boolean { return stopping; }
/** Archive intent closes member admission durably before quiescence starts. */
export function memberRuntimeAllowed(memberId: string): boolean {
  if (stopping) return false;
  return !!getDatabase().get(`SELECT 1 FROM members m WHERE m.id=? AND m.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM member_archive_intents a WHERE a.member_id=m.id AND a.state='pending')`, memberId);
}
