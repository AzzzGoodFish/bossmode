import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let roomId = "";
let ids: Record<string, string> = {};

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-watch-trigger-"));
  mkdirSync(join(tmpDir, "agents"), { recursive: true });
  for (const agent of ["pm", "qa", "developer"]) {
    writeFileSync(join(tmpDir, "agents", `${agent}.md`), `---\nname: ${agent}\n---\n${agent}`, "utf8");
  }
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom("watch-room", tmpDir, drafts(["pm", "qa", "developer"]), undefined, { promptLeaderMemberName: "pm" });
  roomId = room.id;
  ids = Object.fromEntries(roomStore.getRoomMembers(roomId).map((m) => [m.name, m.id]));
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const { initWatchTrigger } = await import("../../src/engine/watch-trigger.js");
  const { addWatch, listWatches } = await import("../../src/workspace/watch-store.js");
  const { postMessage } = await import("../../src/communication/message-bus.js");
  const onTrigger = vi.fn();
  const unsubscribe = initWatchTrigger(onTrigger);
  return { onTrigger, unsubscribe, addWatch, listWatches, postMessage };
}

describe("watch-trigger", () => {
  it("member message fires the watch: consume-then-trigger, with target name", async () => {
    const { onTrigger, unsubscribe, addWatch, listWatches, postMessage } = await setup();
    addWatch(roomId, ids.pm, ids.qa);

    postMessage(roomId, "qa", "QA report ready", [], { senderMemberId: ids.qa });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(roomId, ids.pm, "qa");
    expect(listWatches(roomId)).toHaveLength(0); // one-shot consumed
    unsubscribe();
  });

  it("fire posts a room system note (consumed)", async () => {
    const { unsubscribe, addWatch, postMessage } = await setup();
    const { getMessages } = await import("../../src/workspace/message-store.js");
    addWatch(roomId, ids.pm, ids.qa);

    postMessage(roomId, "qa", "QA report ready", [], { senderMemberId: ids.qa });

    const notes = getMessages(roomId).filter((m) => m.sender === "system").map((m) => m.content);
    expect(notes).toContain("pm's watch on qa fired (consumed).");
    unsubscribe();
  });

  it("expired watches surface as room system notes while the room is active", async () => {
    const { onTrigger, unsubscribe, postMessage } = await setup();
    const { getMessages } = await import("../../src/workspace/message-store.js");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const now = Date.now();
    writeFileSync(join(tmpDir, "rooms", roomId, "watches.json"), JSON.stringify([
      { id: "watch-stale", watcherMemberId: ids.pm, targetMemberId: ids.qa, createdAt: now - 8 * 24 * 3600_000, expiresAt: now - 1000 },
    ]), "utf-8");

    postMessage(roomId, "developer", "any member message", [], { senderMemberId: ids.developer });

    const notes = getMessages(roomId).filter((m) => m.sender === "system").map((m) => m.content);
    expect(notes).toContain("pm's watch on qa expired.");
    expect(onTrigger).not.toHaveBeenCalled(); // expired ≠ fired
    unsubscribe();
  });

  it("user and system messages never trigger", async () => {
    const { onTrigger, unsubscribe, addWatch, postMessage } = await setup();
    addWatch(roomId, ids.pm, ids.qa);

    postMessage(roomId, "user", "hello", []);
    postMessage(roomId, "system", "task event", [], { type: "task_event" });

    expect(onTrigger).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("a member's own watch on themselves is not fired by their message", async () => {
    // subscribe rejects self-watch at the tool layer; the trigger is the second door
    // (e.g. legacy data). Seed directly to exercise it.
    const { onTrigger, unsubscribe, addWatch, listWatches, postMessage } = await setup();
    addWatch(roomId, ids.qa, ids.qa);

    postMessage(roomId, "qa", "self post", [], { senderMemberId: ids.qa });

    expect(onTrigger).not.toHaveBeenCalled();
    expect(listWatches(roomId)).toHaveLength(1); // not consumed
    unsubscribe();
  });

  it("second message after consumption does not re-fire (one-shot)", async () => {
    const { onTrigger, unsubscribe, addWatch, postMessage } = await setup();
    addWatch(roomId, ids.pm, ids.qa);

    postMessage(roomId, "qa", "first", [], { senderMemberId: ids.qa });
    postMessage(roomId, "qa", "second", [], { senderMemberId: ids.qa });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("multiple watchers on the same target all fire; unrelated watches untouched", async () => {
    const { onTrigger, unsubscribe, addWatch, listWatches, postMessage } = await setup();
    addWatch(roomId, ids.pm, ids.qa);
    addWatch(roomId, ids.developer, ids.qa);
    addWatch(roomId, ids.pm, ids.developer); // different target — must survive

    postMessage(roomId, "qa", "report", [], { senderMemberId: ids.qa });

    expect(onTrigger).toHaveBeenCalledTimes(2);
    expect(onTrigger.mock.calls.map((c) => c[1]).sort()).toEqual([ids.developer, ids.pm].sort());
    const left = listWatches(roomId);
    expect(left).toHaveLength(1);
    expect(left[0].targetMemberId).toBe(ids.developer);
    unsubscribe();
  });

  it("watch on a watcher who left the room is consumed and dropped silently", async () => {
    const { onTrigger, unsubscribe, addWatch, listWatches, postMessage } = await setup();
    addWatch(roomId, "rm_ghost", ids.qa); // no such member

    postMessage(roomId, "qa", "report", [], { senderMemberId: ids.qa });

    expect(onTrigger).not.toHaveBeenCalled();
    expect(listWatches(roomId)).toHaveLength(0); // consumed, not retried
    unsubscribe();
  });
});
