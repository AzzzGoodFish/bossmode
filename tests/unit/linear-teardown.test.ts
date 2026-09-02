/**
 * fish 2026-09-02 teardown order: Linear integration removed outright —
 * no compat routes, no Task linear fields, no sync dispatch.
 */
import { describe, expect, it } from "vitest";
import { createTestServer, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

setupConfigMock();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", {
    body: { username: "testuser", password: "testpass" },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("linear teardown", () => {
  it("/api/integrations/* is gone (404, not 410)", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    for (const [method, path, body] of [
      ["GET", "/api/integrations/linear", undefined],
      ["PUT", "/api/integrations/linear", { apiKey: "x" }],
      ["DELETE", "/api/integrations/linear", undefined],
    ] as const) {
      const res = await jsonRequest(ts.port, method, path, { token, body });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    await new Promise<void>((r) => ts.server.close(() => r()));
  });

  it("task payloads carry no linear fields", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cwd = mkdtempSync(join(tmpdir(), "bm-teardown-"));
    const room = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token, body: { name: "teardown-room", cwd, memberIds: [] },
    });
    const roomId = JSON.parse(room.body).id as string;
    const task = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/tasks`, {
      token, body: { title: "no-linear", createdBy: "testuser" },
    });
    expect(task.status).toBe(200);
    expect(JSON.parse(task.body).linearIssueId).toBeUndefined();
    expect(JSON.parse(task.body).linearSyncError).toBeUndefined();
    expect(JSON.stringify(JSON.parse(task.body))).not.toContain("linearIssue");
    await new Promise<void>((r) => ts.server.close(() => r()));
  });
});
