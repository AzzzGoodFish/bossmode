import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bossmode-token-usage-"));
  vi.resetModules();
  vi.stubEnv("BOSSMODE_DIR", dir);
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "developer.md"), "---\nname: developer\n---\ndeveloper", "utf8");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("token usage store", () => {
  it("aggregates message_end usage for a member across rooms", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { getMemberTokenUsage } = await import("../../src/workspace/token-usage-store.js");

    const roomA = roomStore.createRoom("A", dir, drafts(["developer"]));
    const roomB = roomStore.createRoom("B", dir, drafts(["developer"]));

    const eventsA = join(roomStore.roomDir(roomA.id), "agent-events");
    const eventsB = join(roomStore.roomDir(roomB.id), "agent-events");
    mkdirSync(eventsA, { recursive: true });
    mkdirSync(eventsB, { recursive: true });
    writeFileSync(join(eventsA, "developer.jsonl"), [
      JSON.stringify({ type: "message_end", usage: { inputTokens: 10, outputTokens: 5, cacheRead: 3, cacheWrite: 2 } }),
      JSON.stringify({ type: "message_start" }),
      JSON.stringify({ type: "message_end", usage: { inputTokens: 7, outputTokens: 8 } }),
    ].join("\n"));
    writeFileSync(join(eventsB, "developer.jsonl"), [
      JSON.stringify({ type: "message_end", usage: { inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheWrite: 4 } }),
      JSON.stringify({ type: "message_end" }),
    ].join("\n"));

    expect(getMemberTokenUsage("developer")).toEqual({ totalTokens: 45 });
  });

  it("reads token usage by stable room member id", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const { getRoomMemberTokenUsage } = await import("../../src/workspace/token-usage-store.js");

    const room = roomStore.createRoom("A", dir, drafts(["developer"]));
    const [member] = roomStore.getRoomMembers(room.id);
    const events = join(roomStore.roomDir(room.id), "agent-events");
    mkdirSync(events, { recursive: true });
    writeFileSync(join(events, `${member.id}.jsonl`), [
      JSON.stringify({ type: "message_end", usage: { inputTokens: 4, outputTokens: 6 } }),
    ].join("\n"));

    expect(getRoomMemberTokenUsage(room.id, member.id)).toEqual({ totalTokens: 10 });
  });
});
