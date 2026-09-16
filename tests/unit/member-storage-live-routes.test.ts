import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeTestServer, createTestServer, getTestBossmodeDir, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";
setupTestWorkspace();

describe("member APIs use database identity exclusively", () => {
  it("serves fresh members and ignores retired registry records across operational routes", async () => {
    const ts = await createTestServer();
    try {
      const login = await jsonRequest(ts.port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
      const token = JSON.parse(login.body).token;
      const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "Fresh-成员_β", title: "QA" } });
      expect(created.status).toBe(200);
      const id = JSON.parse(created.body).member.memberId;
      expect(existsSync(join(getTestBossmodeDir(), "members.json"))).toBe(false);
      const call = (method: string, suffix: string, body?: unknown) => jsonRequest(ts.port, method, `/api/members/${id}${suffix}`, { token, body });
      const fresh = await call("GET", "/token-usage");
      expect(fresh.status, fresh.body).toBe(200);
      expect(JSON.parse(fresh.body)).toEqual({ totalTokens: 0 });
      expect((await call("GET", "/status")).status).toBe(200);
      // Poison old storage: neither fake identities nor a stale duplicate may become authoritative.
      const retired = join(getTestBossmodeDir(), "members.json");
      const old = JSON.stringify([{ id, name: "wrong-name", agent: "wrong-template" }, { id: "legacy-only", name: "phantom", agent: "general" }]);
      writeFileSync(retired, old);
      for (const suffix of ["/token-usage", "/status"]) {
        expect((await call("GET", suffix)).status).toBe(200);
        expect((await jsonRequest(ts.port, "GET", `/api/members/legacy-only${suffix}`, { token })).status).toBe(404);
      }
      const events = join(getTestBossmodeDir(), "rooms", `dm:${id}`, "agent-events");
      mkdirSync(events, { recursive: true });
      writeFileSync(join(events, `${id}.jsonl`), JSON.stringify({ type: "message_end", ts: 1, usage: { inputTokens: 900, outputTokens: 0 } }) + "\n");
      expect(JSON.parse((await call("GET", "/token-usage")).body)).toEqual({ totalTokens: 0 });
      const { appendAgentEvent } = await import("../../src/data/repositories/event-repository.js");
      appendAgentEvent(`dm:${id}`, { ownerKey: id, memberId: id }, { type: "message_end", ts: 1, usage: { inputTokens: 8, outputTokens: 2 } }, "fixture-usage");
      expect(JSON.parse((await call("GET", "/token-usage")).body)).toEqual({ totalTokens: 10 });
      expect((await call("PATCH", "", { name: "Renamed-成员_γ" })).status).toBe(200);
      expect(JSON.parse((await call("GET", "/token-usage")).body)).toEqual({ totalTokens: 10 });
      expect((await call("GET", "/token-usage?roomId=missing-room")).status).toBe(404);
      expect((await call("PUT", "", { name: "must-not-save" })).status).toBe(404);
      expect(readFileSync(retired, "utf8")).toBe(old);
      expect((await call("GET", "")).status).toBe(200);
    } finally {
      await closeTestServer(ts);
    }
  });
});
