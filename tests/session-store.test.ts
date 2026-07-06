import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("session-store", () => {
  let roomStore: typeof import("../src/workspace/room-store.js");
  let sessionStore: typeof import("../src/workspace/session-store.js");

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-session-test-"));
    vi.resetModules();
    roomStore = await import("../src/workspace/room-store.js");
    sessionStore = await import("../src/workspace/session-store.js");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("clearSession removes resume metadata and preserves runtime", () => {
    const room = roomStore.createRoom("test", "/tmp", ["pm"]);

    sessionStore.saveSession(room.id, "pm", {
      runtime: "pi-cli",
      sessionId: "session-123",
      sessionFile: "/tmp/session.json",
    });

    sessionStore.clearSession(room.id, "pm", "pi-cli");

    expect(sessionStore.getSessions(room.id).pm).toEqual({ runtime: "pi-cli" });
  });

  it("deleteSessionEntry removes a legacy session key", () => {
    const room = roomStore.createRoom("test", "/tmp", ["pm"]);

    sessionStore.saveSession(room.id, "rm_pm", { runtime: "pi-cli", sessionId: "current" });
    sessionStore.saveSession(room.id, "pm", { runtime: "pi-cli", sessionId: "legacy" });

    sessionStore.deleteSessionEntry(room.id, "pm");

    expect(sessionStore.getSessions(room.id)).toEqual({ rm_pm: { runtime: "pi-cli", sessionId: "current" } });
  });
});
