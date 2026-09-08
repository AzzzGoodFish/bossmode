import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getRoomsDir, roomDir, resolveRoomMemberRef } from "./room-store.js";
import { resolveMemberEventFiles } from "./db/backfill.js";
import { logger } from "../foundation/logger.js";

export interface MemberTokenUsageSummary {
  totalTokens: number;
}

function safeTokenNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function usageTotal(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  return safeTokenNumber(u.inputTokens) +
    safeTokenNumber(u.outputTokens) +
    safeTokenNumber(u.cacheRead) +
    safeTokenNumber(u.cacheWrite);
}

function readUsageForMember(roomId: string, memberId: string, dir = join(roomDir(roomId), "agent-events")): number {
  let totalTokens = 0;
  // Reuse canonical file selection so id/name duplicate files are not counted twice.
  for (const { memberId: owner, file } of resolveMemberEventFiles(roomId, dir).files) {
    if (owner !== memberId) continue;
    const path = join(dir, file);

    let content = "";
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      logger.error("token-usage-store", "failed to read agent events", { roomId, memberId, error: String(err) });
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; usage?: unknown };
        if (event.type === "message_end") totalTokens += usageTotal(event.usage);
      } catch (err) {
        logger.error("token-usage-store", "failed to parse agent event", { roomId, memberId, error: String(err) });
      }
    }
  }
  return totalTokens;
}

export function getRoomMemberTokenUsage(roomId: string, memberRef: string): MemberTokenUsageSummary {
  const member = resolveRoomMemberRef(roomId, memberRef);
  return { totalTokens: member ? readUsageForMember(roomId, member.id) : 0 };
}

function directories(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Stable member identity across room, DM and nested topic event scopes. */
export function getMemberTokenUsage(memberId: string): MemberTokenUsageSummary {
  let totalTokens = 0;
  for (const roomId of directories(getRoomsDir())) {
    totalTokens += readUsageForMember(roomId, memberId);
    const topics = join(roomDir(roomId), "topics");
    for (const topicId of directories(topics)) {
      totalTokens += readUsageForMember(roomId, memberId, join(topics, topicId, "agent-events"));
    }
  }
  return { totalTokens };
}
