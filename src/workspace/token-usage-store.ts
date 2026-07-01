import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRoomMembers, listRooms, roomDir } from "./room-store.js";
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

function readUsageForRefs(roomId: string, refs: string[], logName: string): number {
  let totalTokens = 0;
  for (const ref of Array.from(new Set(refs.filter(Boolean)))) {
    const path = join(roomDir(roomId), "agent-events", `${ref}.jsonl`);
    if (!existsSync(path)) continue;

    let content = "";
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      logger.error("token-usage-store", "failed to read agent events", { roomId, memberName: logName, memberRef: ref, error: String(err) });
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; usage?: unknown };
        if (event.type === "message_end") totalTokens += usageTotal(event.usage);
      } catch (err) {
        logger.error("token-usage-store", "failed to parse agent event", { roomId, memberName: logName, memberRef: ref, error: String(err) });
      }
    }
  }
  return totalTokens;
}

export function getRoomMemberTokenUsage(roomId: string, memberRef: string): MemberTokenUsageSummary {
  const member = getRoomMembers(roomId).find((entry) => entry.id === memberRef || entry.name === memberRef);
  const refs = member ? [member.id, member.name] : [memberRef];
  return { totalTokens: readUsageForRefs(roomId, refs, member?.name || memberRef) };
}

export function getMemberTokenUsage(memberName: string): MemberTokenUsageSummary {
  let totalTokens = 0;

  for (const room of listRooms()) {
    const memberIds = getRoomMembers(room.id).filter((member) => member.name === memberName || member.sourceAgent === memberName || member.id === memberName).map((member) => member.id);
    const refs = Array.from(new Set([memberName, ...memberIds]));
    totalTokens += readUsageForRefs(room.id, refs, memberName);
  }

  return { totalTokens };
}
