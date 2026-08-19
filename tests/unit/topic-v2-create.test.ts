import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "", seed: "fork" as "fork" | "fresh" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/shared/config.js")>("../../src/shared/config.js");
  return {
    ...actual,
    getBossmodeDir: () => state.dir,
    ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
    getTopicSeedMode: () => state.seed,
    readConfig: () => ({ runtime: { topicSeedMode: state.seed }, defaults: {} }),
  };
});

import { titleFromMessage, createTopic } from "../../src/workspace/topic-store.js";
import type { Room } from "../../src/shared/types.js";

function writeRoom(roomId: string): Room {
  const roomDir = join(state.dir, "rooms", roomId);
  mkdirSync(roomDir, { recursive: true });
  const room = {
    id: roomId,
    name: "R",
    cwd: "/tmp",
    members: ["pm"],
    roomMembers: [{ id: "rm_pm", name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 }],
    createdAt: 1,
  } as Room;
  writeFileSync(join(roomDir, "room.json"), JSON.stringify(room), "utf-8");
  return room;
}

describe("titleFromMessage", () => {
  it("strips leading mentions and takes the first line", () => {
    expect(titleFromMessage("@pm @qa please fix auth\nmore")).toBe("please fix auth");
    expect(titleFromMessage("")).toBe("");
  });
});

describe("createTopic seed default is fork", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-topic-v2-"));
    state.seed = "fork";
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("omitted seedMode writes fork", () => {
    writeRoom("roomA");
    const t = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1" });
    expect(t.seedMode).toBe("fork");
  });

  it("explicit fresh still wins on the store", () => {
    writeRoom("roomA");
    const t = createTopic({ roomId: "roomA", title: "T", anchorMessageId: "m1", seedMode: "fresh" });
    expect(t.seedMode).toBe("fresh");
  });
});
