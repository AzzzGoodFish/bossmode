import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    const legacyQaSessionFile = join(tempDir, "pi-agent", "runtime", "room-a", "qa", "sessions", "session.json");
    mkdirSync(join(tempDir, "pi-agent", "runtime", "room-a", "qa", "sessions"), { recursive: true });
    writeFileSync(join(tempDir, "pi-agent", "runtime", "room-a", "qa", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-old" } }));
    writeFileSync(legacyQaSessionFile, JSON.stringify({ messages: ["keep"] }));
    const roomASessionsPath = join(tempDir, "rooms", "room-a", "sessions.json");
    const roomASessions = JSON.parse(readFileSync(roomASessionsPath, "utf-8"));
    roomASessions.qa.sessionFile = legacyQaSessionFile;
    writeFileSync(roomASessionsPath, JSON.stringify(roomASessions, null, 2));

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
    expect(cursorsA.qa).toBeUndefined();
    expect(sessionsA[qaA.id].sessionId).toBe("s-room-a-qa");
    expect(sessionsA[qaA.id].sessionFile).toBe(join(tempDir, "pi-agent", "runtime", "room-a", qaA.id, "sessions", "session.json"));
    expect(sessionsA.qa).toBeUndefined();
    expect(existsSync(join(tempDir, "rooms", "room-a", "agent-events", `${qaA.id}.jsonl`))).toBe(true);
    expect(readFileSync(join(tempDir, "pi-agent", "runtime", "room-a", qaA.id, "auth.json"), "utf-8")).toContain("sk-old");
    expect(existsSync(join(tempDir, "pi-agent", "runtime", "room-a", qaA.id, "sessions", "session.json"))).toBe(true);
    expect(existsSync(join(tempDir, "pi-agent", "runtime", "room-a", "qa"))).toBe(false);
    expect(existsSync(join(tempDir, "pi-agent", "runtime", ".migrations", "member-runtime-unified-v3.json"))).toBe(true);
    expect(readdirSync(join(tempDir, "pi-agent", "runtime", ".migration-snapshots")).length).toBeGreaterThan(0);

    const beforeIds = roomA.roomMembers.map((m: any) => m.id);
    const beforeRuntimeFiles = readFileSync(join(tempDir, "pi-agent", "runtime", "room-a", qaA.id, "sessions", "session.json"), "utf-8");
    runRoomMemberMigration();
    const rerunA = JSON.parse(readFileSync(join(tempDir, "rooms", "room-a", "room.json"), "utf-8"));
    expect(rerunA.roomMembers.map((m: any) => m.id)).toEqual(beforeIds);
    expect(existsSync(join(tempDir, "pi-agent", "runtime", "room-a", "qa"))).toBe(false);
    expect(readFileSync(join(tempDir, "pi-agent", "runtime", "room-a", qaA.id, "sessions", "session.json"), "utf-8")).toBe(beforeRuntimeFiles);
  });

  it("repairs rc2 sessions that already point at deleted legacy runtime dirs", async () => {
    const memberId = "rm_architect";
    const designerId = "rm_designer";
    const roomDir = join(tempDir, "rooms", "room-rc2");
    const oldSessionFile = join(tempDir, "pi-agent", "runtime", "room-rc2", "architect", "sessions", "session.jsonl");
    const newSessionFile = join(tempDir, "pi-agent", "runtime", "room-rc2", memberId, "sessions", "session.jsonl");
    const missingGlobalSessionFile = join(tempDir, ".pi", "agent", "sessions", "global.jsonl");
    mkdirSync(roomDir, { recursive: true });
    mkdirSync(join(tempDir, "pi-agent", "runtime", "room-rc2", memberId, "sessions"), { recursive: true });
    mkdirSync(join(tempDir, "pi-agent", "runtime", ".migrations"), { recursive: true });
    writeFileSync(newSessionFile, "{}\n");
    writeFileSync(join(tempDir, "pi-agent", "runtime", ".migrations", "member-runtime-unified-v2.json"), JSON.stringify({ rooms: { "room-rc2": true } }));
    writeFileSync(join(roomDir, "room.json"), JSON.stringify({
      id: "room-rc2",
      name: "room-rc2",
      cwd: "/tmp",
      members: ["architect", "designer"],
      roomMembers: [
        { id: memberId, roomId: "room-rc2", name: "architect", sourceAgent: "architect", createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "architect" } },
        { id: designerId, roomId: "room-rc2", name: "designer", sourceAgent: "designer", createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "designer" } },
      ],
      createdAt: 1,
    }, null, 2));
    writeFileSync(join(roomDir, "sessions.json"), JSON.stringify({
      [memberId]: { runtime: "pi-cli", sessionId: "old", sessionFile: oldSessionFile },
      [designerId]: { runtime: "pi-cli", sessionId: "global", sessionFile: missingGlobalSessionFile },
      architect: { runtime: "pi-cli" },
    }, null, 2));

    const { runRoomMemberMigration } = await import("../../src/workspace/room-member-migration.js");
    runRoomMemberMigration();

    const sessions = JSON.parse(readFileSync(join(roomDir, "sessions.json"), "utf-8"));
    expect(sessions[memberId].sessionFile).toBe(newSessionFile);
    expect(sessions[designerId]).toEqual({ runtime: "pi-cli", sessionId: "global" });
    expect(sessions.architect).toBeUndefined();
    expect(existsSync(join(tempDir, "pi-agent", "runtime", "room-rc2", "architect"))).toBe(false);
    expect(existsSync(join(tempDir, "pi-agent", "runtime", ".migrations", "member-runtime-unified-v3.json"))).toBe(true);
  });
});
