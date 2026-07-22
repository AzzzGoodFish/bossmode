// Migration: team-layer-v1
// 1) Seed default team template(s) from global agents if teams/ is empty
// 2) Backfill rooms/<id>/team/ from each room's current members (copy agents from global)
// Idempotent + data-state driven (re-derives correctness from disk, not a stale "done" flag alone).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";
import { getRoomsDir } from "./room-store.js";
import { seedDefaultTeamTemplatesFromAgents, writeTeamPackage } from "./team-store.js";
import type { Room } from "../shared/types.js";

const MIGRATION_ID = "team-layer-v1";

function markerPath(): string {
  return join(getBossmodeDir(), ".migrations", `${MIGRATION_ID}.json`);
}

function roomHasTeamPackage(roomId: string): boolean {
  return existsSync(join(getRoomsDir(), roomId, "team", "team.md"));
}

function backfillRoomTeam(roomId: string): boolean {
  if (roomHasTeamPackage(roomId)) return false;
  const roomPath = join(getRoomsDir(), roomId, "room.json");
  if (!existsSync(roomPath)) return false;
  let room: Room;
  try {
    room = JSON.parse(readFileSync(roomPath, "utf-8")) as Room;
  } catch {
    return false;
  }
  const members = room.roomMembers || [];
  const agents: Array<{ fileName: string; markdown: string }> = [];
  const seen = new Set<string>();
  for (const m of members) {
    const agentName = m.sourceAgent || m.name;
    if (seen.has(agentName)) continue;
    seen.add(agentName);
    const globalPath = join(getBossmodeDir(), "agents", `${agentName}.md`);
    if (existsSync(globalPath)) {
      agents.push({ fileName: `${agentName}.md`, markdown: readFileSync(globalPath, "utf-8") });
      continue;
    }
    // Write a stub so room-local resolution doesn't hard-fail later
    agents.push({
      fileName: `${agentName}.md`,
      markdown: `---\nname: ${agentName}\ndescription: Migrated stub (original agent definition missing)\n---\n\n# ${agentName}\n`,
    });
  }
  if (agents.length === 0) {
    // Still create empty team package so room-local path exists
    agents.push({
      fileName: "member.md",
      markdown: `---\nname: member\ndescription: Placeholder\n---\n\n# Member\n`,
    });
  }
  const leaderId = room.promptLeaderMemberId;
  const leaderName = leaderId ? members.find((m) => m.id === leaderId)?.name : members[0]?.name;
  writeTeamPackage(join(getRoomsDir(), roomId, "team"), {
    name: room.name || roomId,
    description: "Migrated room team (team-layer-v1)",
    version: "1.0.0-migrated",
    leader: leaderName,
    agents,
  });
  // provenance
  if (!room.template) {
    room.template = { name: "migrated", version: "1.0.0-migrated" };
    writeFileSync(roomPath, JSON.stringify(room, null, 2), "utf-8");
  }
  return true;
}

export function runTeamLayerMigration(): void {
  // Always attempt seed (no-op if teams already present)
  try {
    seedDefaultTeamTemplatesFromAgents();
  } catch (err) {
    logger.error("migration", "team-layer-v1 seed failed", { error: String(err) });
  }

  const roomsDir = getRoomsDir();
  if (!existsSync(roomsDir)) {
    writeMarker({ roomsBackfilled: 0 });
    return;
  }

  let backfilled = 0;
  let roomIds: string[] = [];
  try {
    roomIds = readdirSync(roomsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    logger.error("migration", "team-layer-v1 failed to list rooms", { error: String(err) });
    return;
  }

  for (const roomId of roomIds) {
    try {
      if (backfillRoomTeam(roomId)) backfilled += 1;
    } catch (err) {
      logger.error("migration", "team-layer-v1 room backfill failed", { roomId, error: String(err) });
    }
  }

  writeMarker({ roomsBackfilled: backfilled, roomsScanned: roomIds.length });
  logger.info("migration", "team-layer-v1 complete", { backfilled, roomsScanned: roomIds.length });
}

function writeMarker(extra: Record<string, unknown>): void {
  const dir = join(getBossmodeDir(), ".migrations");
  mkdirSync(dir, { recursive: true });
  writeFileSync(markerPath(), JSON.stringify({ migration: MIGRATION_ID, updatedAt: Date.now(), ...extra }, null, 2), "utf-8");
}
