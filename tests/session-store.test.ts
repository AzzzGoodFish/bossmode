import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let tempDir: string;

vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("session-store", () => {
  let roomStore: typeof import("../src/workspace/room-store.js");
  let sessionStore: typeof import("../src/workspace/session-store.js");

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-session-test-"));
    mkdirSync(join(tempDir, "agents"), { recursive: true });
    writeFileSync(join(tempDir, "agents", "pm.md"), "---\nname: pm\n---\npm", "utf8");
    vi.resetModules();
    roomStore = await import("../src/workspace/room-store.js");
    sessionStore = await import("../src/workspace/session-store.js");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes one member current.json reference and reset removes only that reference", () => {
    const room = roomStore.createRoom("test", "/tmp", drafts(["pm"]));
    const archive = join(tempDir, "members", "rm_pm", "sessions", "2026-09-07", "rooms", room.id, "session.jsonl");
    mkdirSync(join(archive, ".."), { recursive: true });
    writeFileSync(archive, "{\"type\":\"session\"}\n", "utf8");

    sessionStore.saveSession(room.id, "rm_pm", { runtime: "pi-cli", sessionId: "session-123", sessionFile: archive });
    expect(sessionStore.getSessions(room.id, "rm_pm")).toEqual({ rm_pm: { runtime: "pi-cli", sessionId: "session-123", sessionFile: archive } });

    sessionStore.clearSession(room.id, "rm_pm", "pi-cli");
    expect(sessionStore.getSessions(room.id, "rm_pm")).toEqual({});
    expect(readFileSync(archive, "utf8")).toBe("{\"type\":\"session\"}\n");
  });

  it("keeps member scope references independent", () => {
    sessionStore.saveSession("room:room_a", "rm_pm", { runtime: "pi-cli", sessionId: "room" });
    sessionStore.saveSession("dm:rm_pm", "rm_pm", { runtime: "pi-cli", sessionId: "dm" });
    sessionStore.deleteSessionEntry("room:room_a", "rm_pm");

    expect(sessionStore.getCurrentSession("rm_pm", "room:room_a")).toBeUndefined();
    expect(sessionStore.getCurrentSession("rm_pm", "dm:rm_pm")).toMatchObject({ sessionId: "dm" });
  });
});
