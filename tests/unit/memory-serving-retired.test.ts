import { it, expect } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, loginAndGetToken, createMockRoom } from "../helpers/test-server.js";
setupTestWorkspace();

// Q4 (record #16636/#20429, confirmed #20991): the dedicated principles/mainline
// serving layer is retired — every old route answers the same 410 shape, while
// persona.md stays readable through the profile layer.
it("retires every dedicated principles/mainline route with 410 while persona stays readable", async () => {
  const server = await createTestServer();
  try {
    const token = await loginAndGetToken(server.port);
    const room = await createMockRoom(server.port, token, "Retired memory", ["alice"]);
    const memberId = room.globalMemberIds![0];
    const headers = { authorization: `Bearer ${token}` };
    const routes = [
      `/api/rooms/${room.id}/principles`,
      `/api/rooms/${room.id}/members/${memberId}/principles`,
      `/api/rooms/${room.id}/members/${memberId}/mainline`,
      `/api/members/${memberId}/memory?layer=principles`,
      `/api/members/${memberId}/memory?layer=mainline`,
    ];
    for (const route of routes) {
      const response = await fetch(`http://127.0.0.1:${server.port}${route}`, { headers });
      expect(response.status, route).toBe(410);
      const body = await response.json();
      expect(body.error, route).toBe("gone");
      expect(String(body.message), route).toMatch(/retired/);
    }
    const profile = await fetch(`http://127.0.0.1:${server.port}/api/members/${memberId}/memory?layer=profile`, { headers });
    expect(profile.status).toBe(200);
  } finally { await closeTestServer(server); }
});
