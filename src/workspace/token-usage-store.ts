import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRooms, roomDir } from "./room-store.js";
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

export function getMemberTokenUsage(memberName: string): MemberTokenUsageSummary {
  let totalTokens = 0;

  for (const room of listRooms()) {
    const path = join(roomDir(room.id), "agent-events", `${memberName}.jsonl`);
    if (!existsSync(path)) continue;

    let content = "";
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      logger.error("token-usage-store", "failed to read agent events", { roomId: room.id, memberName, error: String(err) });
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; usage?: unknown };
        if (event.type === "message_end") {
          totalTokens += usageTotal(event.usage);
        }
      } catch (err) {
        logger.error("token-usage-store", "failed to parse agent event", { roomId: room.id, memberName, error: String(err) });
      }
    }
  }

  return { totalTokens };
}
