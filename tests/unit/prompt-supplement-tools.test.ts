import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-prompt-tools-"));
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("prompt supplement tools", () => {
  it("allows a member to write its own member supplement", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, ["pm", "qa"], undefined, { promptLeaderMemberName: "pm" });

    const result = await handleToolCallback("write_prompt_supplement", room.id, "qa", { scope: "member", content: "QA note" }) as any;
    expect(result.ok).toBe(true);
    const read = await handleToolCallback("read_prompt_supplement", room.id, "qa", { scope: "member" }) as any;
    expect(read.content).toBe("QA note");
  });

  it("allows only the room leader to write room supplement", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, ["pm", "qa"], undefined, { promptLeaderMemberName: "pm" });

    const denied = await handleToolCallback("write_prompt_supplement", room.id, "qa", { scope: "room", content: "No" }) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Only the configured room leader/);

    const allowed = await handleToolCallback("write_prompt_supplement", room.id, "pm", { scope: "room", content: "Room rule" }) as any;
    expect(allowed.ok).toBe(true);
  });

  it("returns clear error when no leader is configured", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, ["pm"]);
    const result = await handleToolCallback("write_prompt_supplement", room.id, "pm", { scope: "room", content: "Room rule" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No room leader/);
  });
});
