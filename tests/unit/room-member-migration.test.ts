import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

let tempDir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("room-member v0.14 migration", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-roommember-migration-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeLegacyRoom(roomId: string, members: string[], overrides = {}) {
    const dir = join(tempDir, "rooms", roomId);
    mkdirSync(join(dir, "agent-events"), { recursive: true });
    writeFileSync(join(dir, "room.json"), JSON.stringify({
      id: roomId,
      name: roomId,
      cwd: "/tmp",
      members,
      memberOverrides: overrides,
      createdAt: 1,
    }, null, 2));
    writeFileSync(join(dir, "cursors.json"), JSON.stringify(Object.fromEntries(members.map((m) => [m, `cursor-${roomId}-${m}`])), null, 2));
    writeFileSync(join(dir, "sessions.json"), JSON.stringify(Object.fromEntries(members.map((m) => [m, { runtime: "pi-cli", sessionId: `s-${roomId}-${m}` }]))));
    for (const m of members) writeFileSync(join(dir, "agent-events", `${m}.jsonl`), `${JSON.stringify({ type: "message_end", usage: { inputTokens: 1 } })}\n`);
  }

  it("creates stable room-local member ids and copies legacy persistence keys idempotently", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "members.json"), JSON.stringify([
      { id: "global-qa", name: "qa", agent: "qa", runtime: "pi-cli", thinkingLevel: "off", model: "anthropic/global" },
    ], null, 2));
    writeLegacyRoom("room-a", ["qa", "developer"], { qa: { thinkingLevel: "high", mcpServers: ["playwright"] } });
    writeLegacyRoom("room-b", ["qa"], { qa: { thinkingLevel: "low" } });

    const { runRoomMemberMigration } = await import("../../src/workspace/room-member-migration.js");
    runRoomMemberMigration();

    const roomA = JSON.parse(readFileSync(join(tempDir, "rooms", "room-a", "room.json"), "utf-8"));
    const roomB = JSON.parse(readFileSync(join(tempDir, "rooms", "room-b", "room.json"), "utf-8"));
    const qaA = roomA.roomMembers.find((m: any) => m.name === "qa");
    const qaB = roomB.roomMembers.find((m: any) => m.name === "qa");

    expect(qaA.id).toMatch(/^rm_/);
    expect(qaB.id).toMatch(/^rm_/);
    expect(qaA.id).not.toBe(qaB.id);
    expect(qaA.sourceAgent).toBe("qa");
    expect(qaA.config).toMatchObject({ model: "anthropic/global", thinkingLevel: "high", mcpServers: ["playwright"] });
    expect(roomA.members).toEqual(["qa", "developer"]);

    const cursorsA = JSON.parse(readFileSync(join(tempDir, "rooms", "room-a", "cursors.json"), "utf-8"));
    const sessionsA = JSON.parse(readFileSync(join(tempDir, "rooms", "room-a", "sessions.json"), "utf-8"));
    expect(cursorsA[qaA.id]).toBe("cursor-room-a-qa");
    expect(sessionsA[qaA.id].sessionId).toBe("s-room-a-qa");
    expect(existsSync(join(tempDir, "rooms", "room-a", "agent-events", `${qaA.id}.jsonl`))).toBe(true);

    const beforeIds = roomA.roomMembers.map((m: any) => m.id);
    runRoomMemberMigration();
    const rerunA = JSON.parse(readFileSync(join(tempDir, "rooms", "room-a", "room.json"), "utf-8"));
    expect(rerunA.roomMembers.map((m: any) => m.id)).toEqual(beforeIds);
  });
});
