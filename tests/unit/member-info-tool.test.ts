/**
 * member_info tool (batch 3: member_status → member_info).
 *
 * Locks: member-level read-only lookup by name or id — name + description
 * (title storage until the profile rename) + live status from the same source
 * as the member panel (① B4: one runtime per member, one status). Never activates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ tmpDir: "" }));

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.tmpDir,
}));

const members = [
  { id: "mem_pm", name: "pm", title: "Product lead" },
  { id: "mem_qa", name: "qa", title: "" },
  { id: "mem_des", name: "designer", title: "" },
];

vi.mock("../../src/member/member-registry.js", () => ({
  resolveMemberRef: (ref: string) =>
    members.find((m) => m.id === ref || m.name === ref) ?? null,
}));

const getMemberActiveScopes = vi.fn((id: string) => (id === "mem_pm" ? ["room:r1"] : []));
const getScopeLiveStatus = vi.fn((sid: string) => (sid === "dm:mem_qa" ? "working" : "inactive"));
const getMemberLiveStatus = vi.fn((id: string) => (id === "mem_pm" || id === "mem_qa" ? "working" : "idle"));

vi.mock("../../src/engine/agent-manager.js", () => ({
  getMemberActiveScopes: (...args: unknown[]) => getMemberActiveScopes(...(args as [string])),
  getScopeLiveStatus: (...args: unknown[]) => getScopeLiveStatus(...(args as [string])),
  getMemberLiveStatus: (...args: unknown[]) => getMemberLiveStatus(...(args as [string])),
}));

vi.mock("../../src/chat/room-store.js", () => ({}));

import { handleToolCallback } from "../../src/engine/tools.js";

beforeEach(() => {
  state.tmpDir = mkdtempSync(join(tmpdir(), "bossmode-member-info-"));
  getMemberActiveScopes.mockClear();
  getScopeLiveStatus.mockClear();
  getMemberLiveStatus.mockClear();
});

afterEach(() => {
  rmSync(state.tmpDir, { recursive: true, force: true });
});

describe("member_info tool", () => {
  it("resolves by name — name, description and working status", async () => {
    const result = (await handleToolCallback("member_info", "dm:mem_pm", "pm", { member: "pm" })) as any;
    expect(result.ok).toBe(true);
    expect(result.member).toMatchObject({ id: "mem_pm", name: "pm", description: "Product lead", status: "working" });
  });

  it("resolves by id and reports idle when no scope is working", async () => {
    const result = (await handleToolCallback("member_info", "dm:mem_qa", "qa", { member: "mem_des" })) as any;
    expect(result.ok).toBe(true);
    expect(result.member).toMatchObject({ name: "designer", description: "", status: "idle" });
  });

  it("counts the member-level working status", async () => {
    const result = (await handleToolCallback("member_info", "room:r1", "pm", { member: "qa" })) as any;
    expect(result.ok).toBe(true);
    expect(result.member.status).toBe("working");
    expect(getMemberLiveStatus).toHaveBeenCalledWith("mem_qa");
  });

  it("errors without throwing on unknown member and missing param", async () => {
    const missing = (await handleToolCallback("member_info", "room:r1", "pm", {})) as any;
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/member is required/);
    const unknown = (await handleToolCallback("member_info", "room:r1", "pm", { member: "ghost" })) as any;
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Member not found/);
  });
});
