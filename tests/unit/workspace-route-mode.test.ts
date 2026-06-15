import { beforeAll, describe, expect, it, vi } from "vitest";

let workspaceResourceRouteMode: typeof import("../../web/src/pages/Layout").workspaceResourceRouteMode;
let patchRoomAgentStatus: typeof import("../../web/src/pages/Layout").patchRoomAgentStatus;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  ({ workspaceResourceRouteMode, patchRoomAgentStatus } = await import("../../web/src/pages/Layout"));
});

describe("workspace resource route mode", () => {
  it("treats null as list, __new__ as create, and names as detail", () => {
    expect(workspaceResourceRouteMode(null)).toBe("list");
    expect(workspaceResourceRouteMode("__new__")).toBe("create");
    expect(workspaceResourceRouteMode("pm")).toBe("detail");
  });
});

describe("room list live agent status patch", () => {
  it("patches only the matching room and preserves other agent statuses", () => {
    const rooms: any[] = [
      { id: "room-a", name: "A", cwd: "/tmp", members: ["pm", "qa"], agentStatuses: { pm: "idle" } },
      { id: "room-b", name: "B", cwd: "/tmp", members: ["pm"], agentStatuses: { pm: "working" } },
    ];

    const next = patchRoomAgentStatus(rooms, "room-a", "qa", "working");

    expect(next).not.toBe(rooms);
    expect(next[0]).toEqual({
      ...rooms[0],
      agentStatuses: { pm: "idle", qa: "working" },
    });
    expect(next[1]).toBe(rooms[1]);
  });

  it("returns the same array when the status is unchanged", () => {
    const rooms: any[] = [
      { id: "room-a", name: "A", cwd: "/tmp", members: ["pm"], agentStatuses: { pm: "idle" } },
    ];

    expect(patchRoomAgentStatus(rooms, "room-a", "pm", "idle")).toBe(rooms);
  });
});
