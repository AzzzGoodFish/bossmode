import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-watch-store-"));
  mkdirSync(join(tmpDir, "rooms", "room-a"), { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("watch-store", () => {
  it("add + list roundtrip", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    const rec = store.addWatch("room-a", "rm_pm", "rm_qa");
    expect(rec.id).toMatch(/^watch-/);
    expect(rec.watcherMemberId).toBe("rm_pm");
    expect(rec.targetMemberId).toBe("rm_qa");
    expect(rec.expiresAt).toBeGreaterThan(rec.createdAt);

    const all = store.listWatches("room-a");
    expect(all).toHaveLength(1);
    expect(store.listWatches("room-a", "rm_pm")).toHaveLength(1);
    expect(store.listWatches("room-a", "rm_qa")).toHaveLength(0);
  });

  it("re-subscribing same (watcher, target) replaces the record", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    const first = store.addWatch("room-a", "rm_pm", "rm_qa");
    const second = store.addWatch("room-a", "rm_pm", "rm_qa");
    expect(second.id).not.toBe(first.id);
    expect(store.listWatches("room-a")).toHaveLength(1);
    expect(store.listWatches("room-a")[0].id).toBe(second.id);
  });

  it("removeWatch deletes only the matching pair", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    store.addWatch("room-a", "rm_pm", "rm_qa");
    store.addWatch("room-a", "rm_pm", "rm_dev");
    expect(store.removeWatch("room-a", "rm_pm", "rm_qa")).toBe(true);
    expect(store.removeWatch("room-a", "rm_pm", "rm_qa")).toBe(false);
    const left = store.listWatches("room-a");
    expect(left).toHaveLength(1);
    expect(left[0].targetMemberId).toBe("rm_dev");
  });

  it("consumeWatch deletes by id and is idempotent", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    const rec = store.addWatch("room-a", "rm_pm", "rm_qa");
    store.consumeWatch("room-a", rec.id);
    expect(store.listWatches("room-a")).toHaveLength(0);
    store.consumeWatch("room-a", rec.id); // no throw
  });

  it("findWatchesForTarget returns only watches on that target", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    store.addWatch("room-a", "rm_pm", "rm_qa");
    store.addWatch("room-a", "rm_pm", "rm_dev");
    store.addWatch("room-a", "rm_leader2", "rm_qa");
    const hits = store.findWatchesForTarget("room-a", "rm_qa");
    expect(hits.map((w) => w.watcherMemberId).sort()).toEqual(["rm_leader2", "rm_pm"]);
    expect(store.findWatchesForTarget("room-a", "rm_nobody")).toHaveLength(0);
  });

  it("lazy TTL sweep drops expired records on read", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    const path = join(tmpDir, "rooms", "room-a", "watches.json");
    const now = Date.now();
    writeFileSync(path, JSON.stringify([
      { id: "watch-old", watcherMemberId: "rm_pm", targetMemberId: "rm_qa", createdAt: now - 8 * 24 * 3600_000, expiresAt: now - 1000 },
      { id: "watch-new", watcherMemberId: "rm_pm", targetMemberId: "rm_dev", createdAt: now, expiresAt: now + 1000 },
    ]), "utf-8");
    const live = store.listWatches("room-a");
    expect(live.map((w) => w.id)).toEqual(["watch-new"]);
  });

  it("corrupt file reads as empty, does not throw", async () => {
    const store = await import("../../src/workspace/watch-store.js");
    writeFileSync(join(tmpDir, "rooms", "room-a", "watches.json"), "{not json", "utf-8");
    expect(store.listWatches("room-a")).toEqual([]);
  });

  it("persists across module re-import (restart survival)", async () => {
    let store = await import("../../src/workspace/watch-store.js");
    store.addWatch("room-a", "rm_pm", "rm_qa");
    vi.resetModules();
    store = await import("../../src/workspace/watch-store.js");
    expect(store.listWatches("room-a")).toHaveLength(1);
  });
});
