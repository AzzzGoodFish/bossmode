import { getDatabase, type Database } from "../data/database.js";
import { storageScopeId } from "./conversations.js";
import { readMessages, validateMessage, type Message } from "./messages.js";

export interface ArchiveSummary {
  summary: string;
  archivedCount: number;
  range: [string, string];
  ts: number;
}

export interface MessageArchive {
  timestamp: number;
  hasMessages: boolean;
  hasSummary: boolean;
}

function archiveTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid archive timestamp");
}

function validateSummary(value: ArchiveSummary): void {
  if (typeof value?.summary !== "string" || !Number.isSafeInteger(value.archivedCount) || value.archivedCount < 0 ||
    !Array.isArray(value.range) || value.range.length !== 2 || value.range.some((part) => typeof part !== "string") ||
    !Number.isFinite(value.ts)) throw new Error("Invalid archive summary");
}

export function importArchivedMessage(
  db: Database,
  scope: string,
  archiveTs: number,
  ordinal: number,
  message: Message,
): void {
  archiveTimestamp(archiveTs);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("Invalid archive ordinal");
  validateMessage(message);
  const scopeId = storageScopeId(scope);
  db.run(
    "INSERT INTO message_archive_entries VALUES(?,?,?,?,?,?,?,?,?,?)",
    scopeId, archiveTs, ordinal, message.id, message.seq ?? null, message.ts,
    message.sender, message.senderMemberId ?? null, message.content, JSON.stringify(message),
  );
  db.run(`INSERT INTO message_archives(scope_id,archive_ts,has_messages) VALUES(?,?,1)
    ON CONFLICT(scope_id,archive_ts) DO UPDATE SET has_messages=1`, scopeId, archiveTs);
}

export function readArchivedMessages(scope: string, archiveTs: number, db: Database = getDatabase()): Message[] {
  archiveTimestamp(archiveTs);
  return db.all<{ payload_json: string }>(
    "SELECT payload_json FROM message_archive_entries WHERE scope_id=? AND archive_ts=? ORDER BY ordinal",
    storageScopeId(scope), archiveTs,
  ).map((row) => JSON.parse(row.payload_json) as Message);
}

export function listArchives(scope: string, db: Database = getDatabase()): MessageArchive[] {
  return db.all<{ archive_ts: number; has_messages: number; summary_json: string | null }>(
    "SELECT * FROM message_archives WHERE scope_id=? ORDER BY archive_ts DESC",
    storageScopeId(scope),
  ).map((row) => ({ timestamp: row.archive_ts, hasMessages: Boolean(row.has_messages), hasSummary: row.summary_json !== null }));
}

export function saveArchiveSummary(
  scope: string,
  timestamp: number,
  value: ArchiveSummary,
  db: Database = getDatabase(),
): void {
  archiveTimestamp(timestamp);
  validateSummary(value);
  db.run(`INSERT INTO message_archives(scope_id,archive_ts,summary_json) VALUES(?,?,?)
    ON CONFLICT(scope_id,archive_ts) DO UPDATE SET summary_json=excluded.summary_json`,
  storageScopeId(scope), timestamp, JSON.stringify(value));
}

export function readArchiveSummary(scope: string, timestamp: number, db: Database = getDatabase()): ArchiveSummary | null {
  archiveTimestamp(timestamp);
  const row = db.get<{ summary_json: string | null }>(
    "SELECT summary_json FROM message_archives WHERE scope_id=? AND archive_ts=?",
    storageScopeId(scope), timestamp,
  );
  return row?.summary_json ? JSON.parse(row.summary_json) as ArchiveSummary : null;
}

export function archiveMessages(
  scope: string,
  keepCount = 50,
  db: Database = getDatabase(),
): { archived: Message[]; kept: Message[]; timestamp: number } | null {
  if (!Number.isSafeInteger(keepCount) || keepCount < 0) throw new Error("Invalid archive keep count");
  const scopeId = storageScopeId(scope);
  return db.transaction((tx) => {
    const messages = readMessages(scopeId, tx);
    if (messages.length <= keepCount) return null;
    const archived = messages.slice(0, messages.length - keepCount);
    const kept = messages.slice(messages.length - keepCount);
    const maximum = tx.get<{ ts: number | null }>(
      "SELECT MAX(archive_ts) ts FROM message_archives WHERE scope_id=?", scopeId,
    )?.ts ?? -1;
    const timestamp = Math.max(Date.now(), maximum + 1);
    archived.forEach((message, ordinal) => {
      importArchivedMessage(tx, scopeId, timestamp, ordinal, message);
      tx.run("DELETE FROM messages WHERE scope_id=? AND id=?", scopeId, message.id);
    });
    return { archived, kept, timestamp };
  });
}
