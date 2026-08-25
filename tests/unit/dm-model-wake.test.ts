/**
 * rc.1 gap: PATCH config model none→some must wake DM (activateDmMember).
 * Changing an already-set model must NOT re-trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestServer, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

setupConfigMock();

const activateDmMember = vi.fn(async () => {});

vi.mock("../../src/engine/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/agent-manager.js")>(
    "../../src/engine/agent-manager.js",
  );
  return {
    ...actual,
    activateDmMember: (...args: unknown[]) => activateDmMember(...args),
  };
});

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", {
    body: { username: "testuser", password: "testpass" },
  });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("DM model wake (config PATCH none→some)", () => {
  beforeEach(() => {
    activateDmMember.mockClear();
  });
  afterEach(() => {
    activateDmMember.mockReset();
  });

  it("triggers activateDmMember when model goes from none to set", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "wake-bot" },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;
    const scope = `dm:${memberId}`;

    const patch = await jsonRequest(
      ts.port,
      "PATCH",
      `/api/members/${memberId}/config?scope=${encodeURIComponent(scope)}`,
      {
        token,
        body: { model: "provider/model-a", credentialId: "cred-a" },
      },
    );
    expect(patch.status).toBe(200);

    // Fire-and-forget after response — allow microtask/timer to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(activateDmMember).toHaveBeenCalledTimes(1);
    expect(activateDmMember).toHaveBeenCalledWith(memberId);

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, {
      token,
      body: { confirm: true },
    });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("does not re-trigger when model already set", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "wake-bot-2", model: "provider/model-a", credentialId: "cred-a" },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;
    const scope = `dm:${memberId}`;
    activateDmMember.mockClear();

    const patch = await jsonRequest(
      ts.port,
      "PATCH",
      `/api/members/${memberId}/config?scope=${encodeURIComponent(scope)}`,
      {
        token,
        body: { model: "provider/model-b", credentialId: "cred-b" },
      },
    );
    expect(patch.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(activateDmMember).not.toHaveBeenCalled();

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, {
      token,
      body: { confirm: true },
    });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });
});
