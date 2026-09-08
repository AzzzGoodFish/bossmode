import { it, expect } from "vitest";
import { WebSocket } from "ws";
import { createTestServer, closeTestServer, setupConfigMock, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
setupConfigMock();

it("global PATCH publishes committed profile to authenticated clients and rejects the old room rename path", async () => {
  const server = await createTestServer();
  let ws: WebSocket | undefined;
  try {
    const token = await loginAndGetToken(server.port);
    const request = (method: string, path: string, body?: unknown) => jsonRequest(server.port, method, path, { token, body });
    const created = await request("POST", "/api/members", { name: "Api before", title: "Original" });
    const id = JSON.parse(created.body).member.memberId;
    const rooms = await import("../../src/workspace/room-store.js");
    const room = rooms.createRoom("Profile API", undefined, []);
    rooms.stampGlobalMemberIds(room.id, [id]);
    ws = new WebSocket(`${server.wsUrl}?token=${token}`);
    await new Promise<void>((resolve, reject) => { ws!.once("open", resolve); ws!.once("error", reject); });
    const received: any[] = [];
    let resolveProfile!: (event: any) => void;
    const profileEvent = new Promise<any>(resolve => { resolveProfile = resolve; });
    ws.on("message", raw => { const event = JSON.parse(raw.toString()); received.push(event); if (event.type === "member:profile") resolveProfile(event); });
    const changed = await request("PATCH", `/api/members/${id}`, { name: "接口 成员", title: null });
    expect(changed.status, changed.body).toBe(200);
    expect(await profileEvent).toEqual({ type: "member:profile", memberId: id, name: "接口 成员", title: null });
    expect(JSON.parse(changed.body).member).toMatchObject({ memberId: id, name: "接口 成员", title: null });
    const denied = await request("PATCH", `/api/rooms/${room.id}/members/${id}`, { name: "must not rename" });
    expect(denied.status).toBe(400);
    expect(JSON.parse(denied.body).error).toBe("member_profile_is_global");
    for (const name of ["all", "USER", " system "]) {
      const bad = await request("POST", "/api/members", { name });
      expect(bad.status, bad.body).toBe(400);
      expect(JSON.parse(bad.body).message).toMatch(/reserved/);
    }
    expect((await request("PATCH", `/api/members/${id}`, { title: 42 })).status).toBe(400);
    expect(JSON.parse((await request("GET", `/api/members/${id}`)).body).member.name).toBe("接口 成员");
    expect(received.filter(e => e.type === "member:profile")).toHaveLength(1);
    const unicodeRoom = await request("POST", "/api/rooms", { name: "Unicode room", memberIds: [id], leaderMemberId: id });
    expect(unicodeRoom.status, unicodeRoom.body).toBe(200);
    const otherRoom = rooms.createRoom("Invite renamed member", undefined, []);
    rooms.stampGlobalMemberIds(otherRoom.id, []);
    const invite = await request("POST", `/api/rooms/${otherRoom.id}/members`, { memberId: id });
    expect(invite.status, invite.body).toBe(200);
    expect(rooms.getRoomMembers(otherRoom.id).map(member => member.id)).toEqual([id]);
  } finally { ws?.close(); await closeTestServer(server); }
});
