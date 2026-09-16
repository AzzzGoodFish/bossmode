import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { coreFixture } from "../helpers/core-fixture.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
let fixture: ReturnType<typeof coreFixture>;
const roomId = "runtime-room";
beforeEach(() => {
  fixture = coreFixture();
  new MembersRepository(fixture.db).insert({id: "mem_test", name: "test", agentTemplate: "general", global: {},
    createdAt: 1, updatedAt: 2, unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}});
  new ConversationsRepository(fixture.db).upsertRoom({id: roomId, name: "Runtime", members: [], createdAt: 1});
});
afterEach(() => fixture.close());

describe("runtime-state persistence (member-level, ① B8 / C3)", () => {
  const memberId = "mem_test";

  it("writes and reads a contract fingerprint — member-keyed, no scope column", async () => {
    const { setContractFingerprint, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    setContractFingerprint(memberId, "abc123", 3);
    const entry = getRuntimeStateEntry(memberId);
    expect(entry.contractFingerprint).toBe("abc123", 3);
    expect(entry.driftNotified).toBeUndefined();
    // One checkpoint per member: the scope column is gone from the table.
    const columns = fixture.db.all<{ name: string }>("PRAGMA table_info(runtime_checkpoints)").map((c) => c.name);
    expect(columns).not.toContain("scope_id");
    expect(fixture.db.all("SELECT member_id FROM runtime_checkpoints")).toEqual([{ member_id: memberId }]);
  });

  it("records drift notification and reads it back", async () => {
    const { setContractFingerprint, markDriftNotified, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    setContractFingerprint(memberId, "old", 1);
    markDriftNotified(memberId, 2);
    expect(getRuntimeStateEntry(memberId).driftNotified).toBe(2);
  });

  it("marks and clears mount staleness", async () => {
    const { markStaleMounts, clearStaleMounts, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    markStaleMounts(memberId, ["mcpServers"]);
    expect(getRuntimeStateEntry(memberId).staleMounts?.fields).toEqual(["mcpServers"]);

    markStaleMounts(memberId, ["mcpServers", "legacy-marker"]);
    expect(getRuntimeStateEntry(memberId).staleMounts?.fields).toEqual(expect.arrayContaining(["mcpServers", "legacy-marker"]));

    clearStaleMounts(memberId);
    expect(getRuntimeStateEntry(memberId).staleMounts).toBeUndefined();
  });

  it("persists SQL timestamps across reopen without a JSON sidecar", async () => {
    const { setContractFingerprint, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    vi.spyOn(Date, "now").mockReturnValue(1234);
    setContractFingerprint(memberId, "disk-test", 5);
    vi.restoreAllMocks();
    expect(fixture.db.get("SELECT updated_at FROM runtime_checkpoints")).toEqual({updated_at: 1234});
    fixture.reopen();
    expect(getRuntimeStateEntry(memberId)).toEqual({contractFingerprint: "disk-test", contractVersion: 5});
    expect(existsSync(join(fixture.root, "rooms", roomId, "runtime-state.json"))).toBe(false);
  });

  it("clears the full entry on reset", async () => {
    const { setContractFingerprint, markStaleMounts, clearRuntimeStateEntry, readRuntimeState } = await import("../../src/workspace/runtime-state.js");
    setContractFingerprint(memberId, "to-clear", 4);
    markStaleMounts(memberId, ["mcpServers"]);
    clearRuntimeStateEntry(memberId);
    expect(readRuntimeState()[memberId]).toBeUndefined();
  });

  it("an absent member reads empty without fabricating a checkpoint", async () => {
    const { readRuntimeState, getRuntimeStateEntry } = await import("../../src/workspace/runtime-state.js");
    expect(readRuntimeState()).toEqual({});
    expect(getRuntimeStateEntry("mem_missing")).toEqual({});
  });
});
