import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  readConfig: () => ({ runtime: {}, defaults: {}, apiKeys: {} }),
}));

let roomId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bm-rt-state-"));
  vi.resetModules();
  // Create a room so runtime-state.json has a directory to live in.
  const { createRoom } = await import("../../src/workspace/room-store.js");
  roomId = createRoom("rt-state-test", dir, []).id;
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("runtime-state persistence", () => {
  const memberId = "mem_test";

  it("writes and reads a contract fingerprint", async () => {
    const { setContractFingerprint, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "abc123");
    const entry = getRuntimeStateEntry(scopeId, memberId);
    expect(entry.contractFingerprint).toBe("abc123");
    expect(entry.driftNotified).toBeUndefined();
  });

  it("records drift notification and reads it back", async () => {
    const { setContractFingerprint, markDriftNotified, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "old");
    markDriftNotified(scopeId, memberId, "new");
    expect(getRuntimeStateEntry(scopeId, memberId).driftNotified).toBe("new");
  });

  it("marks and clears mount staleness", async () => {
    const { markStaleMounts, clearStaleMounts, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    markStaleMounts(scopeId, memberId, ["mcpServers"]);
    expect(getRuntimeStateEntry(scopeId, memberId).staleMounts?.fields).toEqual(["mcpServers"]);

    markStaleMounts(scopeId, memberId, ["extensions"]);
    expect(getRuntimeStateEntry(scopeId, memberId).staleMounts?.fields).toEqual(expect.arrayContaining(["mcpServers", "extensions"]));

    clearStaleMounts(scopeId, memberId);
    expect(getRuntimeStateEntry(scopeId, memberId).staleMounts).toBeUndefined();
  });

  it("persists to disk as JSON", async () => {
    const { setContractFingerprint } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "disk-test");
    const path = join(dir, "rooms", roomId, "runtime-state.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw[`${scopeId}:${memberId}`].contractFingerprint).toBe("disk-test");
  });

  it("clears the full entry on reset", async () => {
    const { setContractFingerprint, markStaleMounts, clearRuntimeStateEntry, readRuntimeState } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "to-clear");
    markStaleMounts(scopeId, memberId, ["mcpServers"]);
    clearRuntimeStateEntry(scopeId, memberId);
    expect(readRuntimeState(scopeId)[`${scopeId}:${memberId}`]).toBeUndefined();
  });

  it("missing/corrupt state reads as empty (quiet fallback)", async () => {
    const { readRuntimeState } = await import("../../src/workspace/runtime-state.js");
    expect(readRuntimeState("room:nonexistent-room")).toEqual({});
  });
});
