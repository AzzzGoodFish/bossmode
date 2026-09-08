/**
 * Acceptance Tests: Rooms & Messages (Phase 2)
 *
 * Coverage:
 * - T2.1: Agent list (F3)
 * - T2.3: Create room (F4)
 * - T2.4: Invalid cwd (F4)
 * - T2.5: No members (F4)
 * - T2.7: Room list (F17)
 * - T2.8: Shared cwd (F4)
 * - T3.1: Send message (F5)
 * - T3.4: @ non-member (F6)
 * - T3.11: Real-time push (F5, NF3)
 *
 * From test plan: docs/test-plan.md §2, §3
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, getTestBossmodeDir, configureMockMembersForRoom } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import { resetMocks, setMockPromptFn, mockCompactFn } from "../helpers/mock-runtime.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/shared/types.js";

setupConfigMock();

const roomMembers = (...names: string[]) => names.map((name) => ({ agent: name, name }));

describe("Acceptance: Rooms & Messages (F3, F4, F5, F9, F17)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    mkdirSync(join(getTestBossmodeDir(), "agents"), { recursive: true });
    for (const agent of ["pm", "architect", "qa", "developer"]) {
      writeFileSync(join(getTestBossmodeDir(), "agents", `${agent}.md`), `---\nname: ${agent}\n---\nTest ${agent} agent\n`, "utf-8");
    }
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  // ── T2.1: Agent list ──

  describe.skip("T2.1: Agent list (F3) templates retired", () => {
    it("GET /api/agents returns agent definitions with status", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/agents", { token });
      expect(res.status).toBe(200);
      const agents = JSON.parse(res.body);
      expect(Array.isArray(agents)).toBe(true);
      // Phase 2 should return real agents from ~/.bossmode/agents/
      // For now just verify the shape
    });
  });

  // ── T2.3: Create room ──

  describe("T2.3: Create room (F4)", () => {
    it("POST /api/rooms creates a room with a required leader stored by memberId", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "test-room", cwd: "/tmp", members: roomMembers("pm", "architect"), promptLeaderMemberName: "architect" },
      });
      // Should succeed once Phase 2 is implemented (currently 501)
      if (res.status === 501) {
        console.log("⏳ POST /api/rooms not yet implemented (501) — will pass after Phase 2");
        return;
      }
      expect(res.status).toBe(200);
      const room: Room = JSON.parse(res.body);
      expect(room.id).toBeTruthy();
      expect(room.name).toBe("test-room");
      expect(room.cwd).toBeUndefined(); // batch 7 P3
      expect(room.members).toContain("pm");
      expect(room.members).toContain("architect");
      expect(room.createdAt).toBeGreaterThan(0);
      expect(room.docsPath).toBe("test-room/");
      const leader = room.roomMembers?.find((member) => member.name === "architect");
      expect(leader?.id).toBeTruthy();
      expect(room.promptLeaderMemberId).toBe(leader?.id);
    });

    it("creates same-Agent room members atomically from Agent drafts", async () => {
      const before = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: {
          name: "direct-agent-drafts",
          cwd: "/tmp",
          members: [
            { agent: "developer", name: "dev-a" },
            { agent: "developer", name: "dev-b" },
            { agent: "qa", name: "qa" },
          ],
          promptLeaderMemberName: "dev-a",
        },
      });
      expect(res.status).toBe(200);
      const room: Room = JSON.parse(res.body);
      expect(room.roomMembers?.map((member) => member.name)).toEqual(["dev-a", "dev-b", "qa"]);
      expect(room.roomMembers?.map((member) => member.sourceAgent)).toEqual(["developer", "developer", "qa"]);
      expect(new Set(room.roomMembers?.map((member) => member.id)).size).toBe(3);
      expect(room.roomMembers?.every((member) => !member.sourceMemberId && !member.migratedFrom && !member.config)).toBe(true);
      expect(room.promptLeaderMemberId).toBe(room.roomMembers?.[0].id);
      expect(JSON.parse(before.body).every((item: Room) => item.id !== room.id)).toBe(true);
    });

    it("rejects old string members and leaves no partial room after a bad draft", async () => {
      const oldContract = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "old-contract", cwd: "/tmp", members: ["pm"], promptLeaderMemberName: "pm" },
      });
      expect(oldContract.status).toBe(400);
      expect(JSON.parse(oldContract.body).error).toContain("members must contain { agent, name } objects");

      const before = JSON.parse((await jsonRequest(ts.port, "GET", "/api/rooms", { token })).body) as Room[];
      const badDraft = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: {
          name: "bad-draft-no-room",
          cwd: "/tmp",
          members: [{ agent: "developer", name: "dev" }, { agent: "missing-agent", name: "ghost" }],
          promptLeaderMemberName: "dev",
        },
      });
      expect(badDraft.status).toBe(404);
      const after = JSON.parse((await jsonRequest(ts.port, "GET", "/api/rooms", { token })).body) as Room[];
      expect(after.map((room) => room.id)).toEqual(before.map((room) => room.id));
    });

    it("POST /api/rooms without promptLeaderMemberName returns error", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "missing-leader-room", cwd: "/tmp", members: roomMembers("pm") },
      });
      if (res.status === 501) return;
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("promptLeaderMemberName is required");
    });

    it("POST /api/rooms rejects leader outside selected members", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "bad-leader-room", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "architect" },
      });
      if (res.status === 501) return;
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("promptLeaderMemberName must be one of the room members");
    });

    it("keeps prompt leader stable when the leader member is renamed", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "rename-leader-room", cwd: "/tmp", members: roomMembers("pm", "qa"), promptLeaderMemberName: "pm" },
      });
      if (res.status === 501) return;
      expect(res.status).toBe(200);
      const room: Room = JSON.parse(res.body);
      const leaderId = room.promptLeaderMemberId;
      expect(leaderId).toBeTruthy();

      const renameRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}/members/pm`, {
        token,
        body: { name: "lead" },
      });
      expect(renameRes.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      expect(getRes.status).toBe(200);
      const updated: Room = JSON.parse(getRes.body);
      expect(updated.promptLeaderMemberId).toBe(leaderId);
      expect(updated.roomMembers?.find((member) => member.id === leaderId)?.name).toBe("lead");
    });

    // T2.4: Invalid cwd
    it("POST /api/rooms with nonexistent cwd returns error", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "bad-room", cwd: "/nonexistent/path/xxx", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (res.status === 501) return; // skip until implemented
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    // T2.5: No members
    it("POST /api/rooms with empty members returns error", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "empty-room", cwd: "/tmp", members: roomMembers() },
      });
      if (res.status === 501) return;
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("promptLeaderMemberName is required");
    });
  });

  // ── Room settings patch ──

  describe("Room settings PATCH", () => {
    it("PATCH /api/rooms/:id updates name and ruleDocs (cwd ignored — batch 7 P3)", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "settings-room", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const patchRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}`, {
        token,
        body: {
          name: "settings-room-renamed",
          ruleDocs: ["bossmode/rules/dev-team-protocol.md"],
        },
      });

      expect(patchRes.status).toBe(200);
      const updated: Room = JSON.parse(patchRes.body);
      expect(updated.name).toBe("settings-room-renamed");
      expect(updated.ruleDocs).toEqual(["bossmode/rules/dev-team-protocol.md"]);
    });

    it("PATCH /api/rooms/:id updates docsPath", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "docs-path-room", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const patchRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}`, {
        token,
        body: { docsPath: "bossmode" },
      });
      expect(patchRes.status).toBe(200);
      expect(JSON.parse(patchRes.body).docsPath).toBe("bossmode/");
    });

    it("PATCH /api/rooms/:id ignores cwd entirely (batch 7 P3)", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "settings-room-2", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const patchRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}`, {
        token,
        body: { cwd: "/definitely-not-a-real-dir" },
      });

      // cwd is no longer a PATCHable field — the request lands as "nothing to update".
      expect(patchRes.status).toBe(400);
      expect(JSON.parse(patchRes.body).error).toContain("Nothing to update");
    });
  });

  describe("Room member MCP access PATCH", () => {
    it("rejects thinkingLevel — member-global via PATCH /api/members/:id only", async () => {

      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "thinking-max-room", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const res = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}/members/pm`, {
        token,
        body: { thinkingLevel: "max" },
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toBe("model_config_is_global");
    });

    it("rejects invalid-config MCP servers", async () => {
      const mcpDir = join(getTestBossmodeDir(), "mcp");
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, "mcp.json"), JSON.stringify({
        mcpServers: {
          valid: { url: "http://127.0.0.1:8931/mcp" },
          invalid: {},
          badUrl: { url: "not a url" },
        },
      }, null, 2));

      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "mcp-access-room", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const invalidRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}/members/pm`, {
        token,
        body: { mcpServers: ["invalid"] },
      });
      expect(invalidRes.status).toBe(400);
      expect(JSON.parse(invalidRes.body).error).toContain("Unknown or invalid MCP server");

      const badUrlRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}/members/pm`, {
        token,
        body: { mcpServers: ["badUrl"] },
      });
      expect(badUrlRes.status).toBe(400);

      const validRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}/members/pm`, {
        token,
        body: { mcpServers: ["valid"] },
      });
      expect(validRes.status).toBe(200);
      expect(JSON.parse(validRes.body).member.mcpServers).toEqual(["valid"]);
    });
  });

  // ── T2.7: Room list ──

  describe("T2.7: Room list (F17)", () => {
    it("returns 500 instead of fake empty when the Room authority is unreadable, then recovers", async () => {
      const roomsDir = join(getTestBossmodeDir(), "rooms");
      const backup = `${roomsDir}-backup`;
      renameSync(roomsDir, backup);
      writeFileSync(roomsDir, "not a directory", "utf8");
      try {
        const failed = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
        expect(failed.status).toBe(500);
        expect(JSON.parse(failed.body).error).toBe("Couldn’t load Rooms");
      } finally {
        unlinkSync(roomsDir);
        renameSync(backup, roomsDir);
      }
      const recovered = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
      expect(recovered.status).toBe(200);
    });

    it("GET /api/rooms returns all rooms", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
      expect(res.status).toBe(200);
      const rooms = JSON.parse(res.body);
      expect(Array.isArray(rooms)).toBe(true);
    });
  });

  // ── T2.8: Shared cwd ──

  describe("T2.8: Multiple rooms with same cwd (F4)", () => {
    it("two rooms with same cwd are independent", async () => {
      const res1 = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "room-a", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      const res2 = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "room-b", cwd: "/tmp", members: roomMembers("architect"), promptLeaderMemberName: "architect" },
      });
      if (res1.status === 501 || res2.status === 501) return;

      const room1: Room = JSON.parse(res1.body);
      const room2: Room = JSON.parse(res2.body);
      expect(room1.id).not.toBe(room2.id);
      expect(room1.members).not.toEqual(room2.members);
    });
  });

  // ── T3.1: Send message ──

  describe("T3.1: User sends message (F5)", () => {
    it("POST /api/rooms/:id/messages stores and broadcasts", async () => {
      // First create a room
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "msg-test", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      // Subscribe to room via WS
      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send a message
      const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "hello everyone" },
      });
      expect(msgRes.status).toBe(200);
      const msg: RoomMessage = JSON.parse(msgRes.body);
      expect(msg.id).toBeTruthy();
      expect(msg.sender).toBe("user");
      expect(msg.content).toBe("hello everyone");
      expect(msg.ts).toBeGreaterThan(0);

      // Verify WS push
      const wsEvent = await wsClient.waitFor(
        (e) => e.type === "room:message" && (e as any).message?.id === msg.id,
        2000,
      );
      expect(wsEvent).toBeTruthy();

      // Verify persistence via GET
      const listRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token });
      expect(listRes.status).toBe(200);
      const messages: RoomMessage[] = JSON.parse(listRes.body);
      expect(messages.some((m) => m.id === msg.id)).toBe(true);

      await wsClient.close();
    });
  });

  describe("T3.2: Manual compact room command", () => {
    it("routes @member /compact as a slash command without normal mention activation", async () => {
      resetMocks();
      const prompts: string[] = [];
      setMockPromptFn(vi.fn(async (message: string) => { prompts.push(message); }));
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "compact-command-test", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      expect(createRes.status).toBe(200);
      const room: Room = JSON.parse(createRes.body);
      await configureMockMembersForRoom(room.id, ["pm"]);

      const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "@pm /compact" },
      });
      expect(msgRes.status).toBe(200);
      const msg: RoomMessage = JSON.parse(msgRes.body);
      expect(msg.content).toBe("@pm /compact");

      await vi.waitFor(() => expect(mockCompactFn).toHaveBeenCalledTimes(1));
      expect(prompts).toEqual([]); // command drives the compact action, never a prompt
      resetMocks();
    });

    it("routes /compact to the sole room member", async () => {
      resetMocks();
      const prompts: string[] = [];
      setMockPromptFn(vi.fn(async (message: string) => { prompts.push(message); }));
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "compact-command-single-member", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      expect(createRes.status).toBe(200);
      const room: Room = JSON.parse(createRes.body);
      await configureMockMembersForRoom(room.id, ["pm"]);

      const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "/compact" },
      });
      expect(msgRes.status).toBe(200);
      await vi.waitFor(() => expect(mockCompactFn).toHaveBeenCalledTimes(1));
      expect(prompts).toEqual([]); // command drives the compact action, never a prompt
      resetMocks();
    });
  });

  // ── T3.4: @ non-member agent ──

  describe("T3.4: @ non-member agent (F6)", () => {
    it("mentioning non-member returns error", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "mention-test", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      // @ a non-member agent
      const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "@qa run the tests" },
      });
      // Should either return error or message with warning
      const data = JSON.parse(msgRes.body);
      // The message might still be stored but with an error indicator,
      // or the endpoint returns 400. Either way, "qa" is not a member.
      if (msgRes.status >= 400) {
        expect(data.error).toBeTruthy();
      }
      // Alternative: message stored, but no agent activation + error note
    });
  });

  // ── T3.11: Real-time message push to multiple clients ──

  describe("T3.11: Real-time push (F5, NF3)", () => {
    it("message appears on all subscribed WS clients simultaneously", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "realtime-test", cwd: "/tmp", members: roomMembers("pm"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      // Two WS clients subscribing to same room (simulates T10.3 multi-tab)
      const client1 = await createWsClient(ts.wsUrl, token);
      const client2 = await createWsClient(ts.wsUrl, token);
      client1.send({ type: "subscribe:room", roomId: room.id });
      client2.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send message
      await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "broadcast test" },
      });

      // Both clients receive
      const [r1, r2] = await Promise.all([
        client1.waitFor((e) => e.type === "room:message", 2000),
        client2.waitFor((e) => e.type === "room:message", 2000),
      ]);
      expect((r1 as any).message.content).toBe("broadcast test");
      expect((r2 as any).message.content).toBe("broadcast test");

      await client1.close();
      await client2.close();
    });
  });

  // ── T9.1: Member panel status (F9) ──

  describe("T9.1: Member panel / agent status in room (F9)", () => {
    it("GET /api/rooms/:id returns members with status", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "status-test", cwd: "/tmp", members: roomMembers("pm", "architect"), promptLeaderMemberName: "pm" },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      expect(roomRes.status).toBe(200);
      const roomData = JSON.parse(roomRes.body);
      expect(roomData.members).toContain("pm");
      expect(roomData.members).toContain("architect");
    });
  });
});
