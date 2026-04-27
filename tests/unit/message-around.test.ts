import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-msg-around-"));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
}));

function seedMessages(roomId: string, count: number) {
  const dir = join(tmpDir, "rooms", roomId);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      id: `msg-${i}`,
      sender: "user",
      content: `Message ${i}`,
      mentions: [],
      ts: Date.now() + i * 1000,
    }));
  }
  writeFileSync(join(dir, "messages.jsonl"), lines.join("\n"), "utf-8");
}

describe("getMessages around", () => {
  it("returns a window centered on the target message", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-1", 50);
    const result = getMessages("around-1", { around: "msg-25", limit: 10 });
    expect(result.length).toBe(10);
    expect(result.some((m) => m.id === "msg-25")).toBe(true);
    // Window: 4 before target + target + 5 after = 10 → msg-21..msg-30
    expect(result[0].id).toBe("msg-21");
    expect(result[9].id).toBe("msg-30");
  });

  it("returns empty array when target not found", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-2", 10);
    const result = getMessages("around-2", { around: "nonexistent", limit: 10 });
    expect(result).toEqual([]);
  });

  it("handles target near the beginning", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-3", 20);
    const result = getMessages("around-3", { around: "msg-2", limit: 10 });
    expect(result.some((m) => m.id === "msg-2")).toBe(true);
    expect(result[0].id).toBe("msg-0"); // Can't go before 0
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("handles target near the end", async () => {
    const { getMessages } = await import("../../src/workspace/message-store.js");
    seedMessages("around-4", 20);
    const result = getMessages("around-4", { around: "msg-18", limit: 10 });
    expect(result.some((m) => m.id === "msg-18")).toBe(true);
    expect(result[result.length - 1].id).toBe("msg-19"); // Can't go past end
  });
});
