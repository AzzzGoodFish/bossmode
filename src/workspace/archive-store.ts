import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { roomDir } from "./room-store.js";
import { readAllMessages, overwriteMessages } from "./message-store.js";
import type { RoomMessage } from "../shared/types.js";
import { parseJsonlLines } from "../shared/jsonl.js";

function archivesDir(roomId: string): string {
  return join(roomDir(roomId), "archives");
}

export function archiveMessages(
  roomId: string,
  keepCount: number = 50,
): { archived: RoomMessage[]; kept: RoomMessage[]; timestamp: number } | null {
  const allMessages = readAllMessages(roomId);

  if (allMessages.length <= keepCount) {
    return null;
  }

  const archived = allMessages.slice(0, allMessages.length - keepCount);
  const kept = allMessages.slice(-keepCount);

  const ts = Date.now();
  const archDir = archivesDir(roomId);
  mkdirSync(archDir, { recursive: true });

  const archiveFile = join(archDir, `${ts}.jsonl`);
  writeFileSync(archiveFile, archived.map((m) => JSON.stringify(m)).join("\n") + "\n", "utf-8");

  // Overwrite messages file with kept messages only
  overwriteMessages(roomId, kept);

  return { archived, kept, timestamp: ts };
}

export function saveArchiveSummary(
  roomId: string,
  summary: string,
  archivedMessages: RoomMessage[],
  timestamp: number,
): void {
  const archDir = archivesDir(roomId);
  mkdirSync(archDir, { recursive: true });

  const summaryData = {
    summary,
    archivedCount: archivedMessages.length,
    range: [
      archivedMessages[0]?.id ?? "",
      archivedMessages[archivedMessages.length - 1]?.id ?? "",
    ],
    ts: timestamp,
  };

  writeFileSync(join(archDir, `${timestamp}.summary.json`), JSON.stringify(summaryData, null, 2), "utf-8");
}

export function listArchives(roomId: string): Array<{
  timestamp: number;
  summaryFile: string | null;
  messagesFile: string | null;
}> {
  const archDir = archivesDir(roomId);
  if (!existsSync(archDir)) return [];

  const files = readdirSync(archDir);
  const timestamps = new Set<number>();

  for (const f of files) {
    const match = f.match(/^(\d+)\.(jsonl|summary\.json)$/);
    if (match) timestamps.add(parseInt(match[1], 10));
  }

  return Array.from(timestamps)
    .sort((a, b) => b - a)
    .map((ts) => ({
      timestamp: ts,
      summaryFile: files.includes(`${ts}.summary.json`) ? join(archDir, `${ts}.summary.json`) : null,
      messagesFile: files.includes(`${ts}.jsonl`) ? join(archDir, `${ts}.jsonl`) : null,
    }));
}

export function readArchiveMessages(roomId: string, timestamp: number): RoomMessage[] {
  const filePath = join(archivesDir(roomId), `${timestamp}.jsonl`);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  if (!content.trim()) return [];

  return parseJsonlLines<RoomMessage>(content, {
    category: "archive-store",
    context: { roomId, timestamp },
  });
}

export function readArchiveSummary(roomId: string, timestamp: number): {
  summary: string;
  archivedCount: number;
  range: [string, string];
  ts: number;
} | null {
  const filePath = join(archivesDir(roomId), `${timestamp}.summary.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf-8"));
}
