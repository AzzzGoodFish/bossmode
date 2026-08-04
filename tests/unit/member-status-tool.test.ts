/**
 * member_status tool (fish 2026-08-04: teammates' idle/working observability).
 *
 * Locks: room-scope read-only report over the runtime instance registry —
 * aggregated status (working > idle > inactive) + active scopes; single-member
 * filter; unknown member / unknown room errors.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ tmpDir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.tmpDir,
}));

const reportFixture = [
  { name: "pm", memberId: "rm_pm", status: "working", activeScopes: [{ scope: "room: bossmode dev", status: "working" }] },
  { name: "qa", memberId: "rm_qa", status: "idle", activeScopes: [{ scope: "room: bossmode dev", status: "idle" }, { scope: "dm", status: "idle" }] },
  { name: "designer", memberId: "rm_des", status: "inactive", activeScopes: [] },
];

const getRoomMemberStatusReport = vi.fn((_roomId: string, memberRef?: string) => {
  if (!memberRef) return reportFixture;
  const hit = reportFixture.find((m) => m.name === memberRef);
  return hit ? [hit] : null;
});

vi.mock("../../src/engine/agent-manager.js", () => ({
  getRoomMemberStatusReport: (...args: unknown[]) => getRoomMemberStatusReport(...(args as [string, string?])),
}));

const ROOM_ID = "room-status-1";

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: (id: string) => (id === "room-status-1" ? { id: "room-status-1", name: "status-room" } : undefined),
}));

import { handleToolCallback } from "../../src/engine/tools.js";

beforeEach(() => {
  state.tmpDir = mkdtempSync(join(tmpdir(), "bossmode-member-status-"));
  getRoomMemberStatusReport.mockClear();
});

afterEach(() => {
  rmSync(state.tmpDir, { recursive: true, force: true });
});

describe("member_status tool", () => {
  it("returns the aggregated report for all room members", async () => {
    const result = (await handleToolCallback("member_status", ROOM_ID, "pm", {})) as any;
    expect(result.ok).toBe(true);
    expect(result.members).toHaveLength(3);
    expect(result.members[0]).toMatchObject({ name: "pm", status: "working" });
    expect(result.members[2]).toMatchObject({ name: "designer", status: "inactive", activeScopes: [] });
    expect(getRoomMemberStatusReport).toHaveBeenCalledWith(ROOM_ID, undefined);
  });

  it("filters to a single member when member param is given", async () => {
    const result = (await handleToolCallback("member_status", ROOM_ID, "pm", { member: "qa" })) as any;
    expect(result.ok).toBe(true);
    expect(result.members).toHaveLength(1);
    expect(result.members[0].name).toBe("qa");
    expect(getRoomMemberStatusReport).toHaveBeenCalledWith(ROOM_ID, "qa");
  });

  it("errors on unknown member and unknown room without throwing", async () => {
    const room = "room-status-1";
    const unknown = (await handleToolCallback("member_status", ROOM_ID, "pm", { member: "ghost" })) as any;
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Member not found/);
    const noRoom = (await handleToolCallback("member_status", "no-such-room", "pm", {})) as any;
    expect(noRoom.ok).toBe(false);
    expect(noRoom.error).toMatch(/Room not found/);
  });
});
