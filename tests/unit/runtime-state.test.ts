import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "../helpers/core-fixture.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
let fixture: ReturnType<typeof coreFixture>;
const roomId = "runtime-room";
beforeEach(() => {
  fixture = coreFixture();
  new MembersRepository(fixture.db).insert({id: "mem_test", name: "test", agentTemplate: "general", global: {},
    createdAt: 1, updatedAt: 2, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}});
  new ConversationsRepository(fixture.db).upsertRoom({id: roomId, name: "Runtime", members: [], createdAt: 1});
});
afterEach(() => fixture.close());

describe("runtime-state persistence", () => {
  const memberId = "mem_test";

  it("writes and reads a contract fingerprint", async () => {
    const { setContractFingerprint, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "abc123", 3);
    const entry = getRuntimeStateEntry(scopeId, memberId);
    expect(entry.contractFingerprint).toBe("abc123", 3);
    expect(entry.driftNotified).toBeUndefined();
  });

  it("records drift notification and reads it back", async () => {
    const { setContractFingerprint, markDriftNotified, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "old", 1);
    markDriftNotified(scopeId, memberId, 2);
    expect(getRuntimeStateEntry(scopeId, memberId).driftNotified).toBe(2);
  });

  it("marks and clears mount staleness", async () => {
    const { markStaleMounts, clearStaleMounts, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    markStaleMounts(scopeId, memberId, ["mcpServers"]);
    expect(getRuntimeStateEntry(scopeId, memberId).staleMounts?.fields).toEqual(["mcpServers"]);

    markStaleMounts(scopeId, memberId, ["mcpServers", "legacy-marker"]);
    expect(getRuntimeStateEntry(scopeId, memberId).staleMounts?.fields).toEqual(expect.arrayContaining(["mcpServers", "legacy-marker"]));

    clearStaleMounts(scopeId, memberId);
    expect(getRuntimeStateEntry(scopeId, memberId).staleMounts).toBeUndefined();
  });

  it("persists SQL timestamps across reopen without a JSON sidecar", async () => {
    const { setContractFingerprint, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    vi.spyOn(Date, "now").mockReturnValue(1234);
    setContractFingerprint(`room:${roomId}`, memberId, "disk-test", 5);
    vi.restoreAllMocks();
    expect(fixture.db.get("SELECT updated_at FROM runtime_checkpoints")).toEqual({updated_at: 1234});
    fixture.reopen();
    expect(getRuntimeStateEntry(`room:${roomId}`, memberId)).toEqual({contractFingerprint: "disk-test", contractVersion: 5});
    expect(existsSync(join(fixture.root, "rooms", roomId, "runtime-state.json"))).toBe(false);
  });

  it("clears the full entry on reset", async () => {
    const { setContractFingerprint, markStaleMounts, clearRuntimeStateEntry, readRuntimeState } = await import("../../src/workspace/runtime-state.js");
    const scopeId = `room:${roomId}`;
    setContractFingerprint(scopeId, memberId, "to-clear", 4);
    markStaleMounts(scopeId, memberId, ["mcpServers"]);
    clearRuntimeStateEntry(scopeId, memberId);
    expect(readRuntimeState(scopeId)[`${scopeId}:${memberId}`]).toBeUndefined();
  });

  it("an absent scope reads empty without fabricating a checkpoint", async () => {
    const { readRuntimeState } = await import("../../src/workspace/runtime-state.js");
    expect(readRuntimeState("room:nonexistent-room")).toEqual({});
  });
});
