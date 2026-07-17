import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-asset-tools-"));
  mkdirSync(join(tmpDir, "agents"), { recursive: true });
  for (const agent of ["pm", "qa"]) writeFileSync(join(tmpDir, "agents", `${agent}.md`), `---\nname: ${agent}\n---\n${agent}`, "utf8");
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("asset tools", () => {
  it("allows a member to write and read its own member principles", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });

    const result = await handleToolCallback("write_asset", room.id, "qa", { asset: "principles", scope: "member", content: "QA note", reason: "user feedback" }) as any;
    expect(result.ok).toBe(true);
    expect(result.budgetHeader).toMatch(/% — \d+\/4,000/);
    const read = await handleToolCallback("read_asset", room.id, "qa", { asset: "principles", scope: "member" }) as any;
    expect(read.content).toBe("QA note");
    expect(read.budget.limit).toBe(4_000);
    expect(read.budget.overLimit).toBe(false);
  });

  it("requires asset and reason", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });

    const badAsset = await handleToolCallback("read_asset", room.id, "qa", { asset: "supplement" }) as any;
    expect(badAsset.ok).toBe(false);
    expect(badAsset.error).toMatch(/asset must be 'principles' or 'mainline'/);
    const noReason = await handleToolCallback("write_asset", room.id, "qa", { asset: "principles", content: "x", reason: " " }) as any;
    expect(noReason.ok).toBe(false);
    expect(noReason.error).toMatch(/reason is required/);
  });

  it("allows only the room leader to write room principles", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });

    const denied = await handleToolCallback("write_asset", room.id, "qa", { asset: "principles", scope: "room", content: "No", reason: "r" }) as any;
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Only the configured room leader/);

    const allowed = await handleToolCallback("write_asset", room.id, "pm", { asset: "principles", scope: "room", content: "Room rule", reason: "decision" }) as any;
    expect(allowed.ok).toBe(true);
    expect(allowed.budget.limit).toBe(8_000);
    // Any member may read room principles
    const read = await handleToolCallback("read_asset", room.id, "qa", { asset: "principles", scope: "room" }) as any;
    expect(read.content).toBe("Room rule");
  });

  it("returns clear error when no leader is configured", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm"]));
    const result = await handleToolCallback("write_asset", room.id, "pm", { asset: "principles", scope: "room", content: "Room rule", reason: "r" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No room leader/);
  });

  it("over-budget writes are rejected with the current full content for same-turn curation", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });

    await handleToolCallback("write_asset", room.id, "qa", { asset: "principles", content: "current rules body", reason: "seed" }) as any;
    const rejected = await handleToolCallback("write_asset", room.id, "qa", { asset: "principles", content: "y".repeat(4_500), reason: "bloat" }) as any;
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/exceed its budget/);
    expect(rejected.error).toContain("current rules body");
    expect(rejected.error).toMatch(/Curate now/);
    // Nothing was persisted
    const read = await handleToolCallback("read_asset", room.id, "qa", { asset: "principles" }) as any;
    expect(read.content).toBe("current rules body");
  });

  it("mainline is member-level: write, read with stale resolution, room scope rejected", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });

    const content = "## 焦点\n\n质量理念。\n\n## 动态索引\n\n- task:task-dead — 已删任务\n";
    const written = await handleToolCallback("write_asset", room.id, "qa", { asset: "mainline", content, reason: "kickoff" }) as any;
    expect(written.ok).toBe(true);
    expect(written.budget.limit).toBe(4_000);

    const read = await handleToolCallback("read_asset", room.id, "qa", { asset: "mainline" }) as any;
    expect(read.ok).toBe(true);
    expect(read.content).toContain("- [stale] task:task-dead — 已删任务");
    expect(read.budgetHeader).toMatch(/% — \d+\/4,000/);

    const roomScope = await handleToolCallback("read_asset", room.id, "qa", { asset: "mainline", scope: "room" }) as any;
    expect(roomScope.ok).toBe(false);
    expect(roomScope.error).toMatch(/member-level only/);
    const roomWrite = await handleToolCallback("write_asset", room.id, "pm", { asset: "mainline", scope: "room", content: "x", reason: "r" }) as any;
    expect(roomWrite.ok).toBe(false);
  });

  it("members cannot read each other's assets (actor-scoped)", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });

    await handleToolCallback("write_asset", room.id, "qa", { asset: "principles", content: "qa-only", reason: "seed" });
    const readAsPm = await handleToolCallback("read_asset", room.id, "pm", { asset: "principles", scope: "member" }) as any;
    expect(readAsPm.content).toBe("");
    const readAsQa = await handleToolCallback("read_asset", room.id, "qa", { asset: "principles", scope: "member" }) as any;
    expect(readAsQa.content).toBe("qa-only");
  });

  it("empty mainline read returns the suggested two-section template", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const room = roomStore.createRoom("r", tmpDir, drafts(["pm", "qa"]), undefined, { promptLeaderMemberName: "pm" });
    const read = await handleToolCallback("read_asset", room.id, "qa", { asset: "mainline" }) as any;
    expect(read.content).toBe("");
    expect(read.suggestedTemplate).toContain("## 焦点");
    expect(read.suggestedTemplate).toContain("## 动态索引");
  });
});
