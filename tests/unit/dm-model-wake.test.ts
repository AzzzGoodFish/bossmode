/**
 * rc.1 gap: PATCH config model none→some must wake DM (activateDmMember).
 * Changing an already-set model must NOT re-trigger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestServer, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";

setupTestWorkspace();

const activateDmMember = vi.fn(async () => {});

vi.mock("../../src/agent/orchestrator/agent-manager.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/agent/orchestrator/agent-manager.js")>(
    "../../src/agent/orchestrator/agent-manager.js",
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

describe("DM model wake (member PATCH none→some)", () => {
  beforeEach(() => {
    activateDmMember.mockClear();
  });
  afterEach(() => {
    activateDmMember.mockReset();
  });

  async function seedProfile(port: number, token: string, slug: string, modelId: string): Promise<string> {
    const res = await jsonRequest(port, "POST", "/api/model-credential-profiles", {
      token,
      body: {
        name: `${slug} profile`,
        providerSlug: slug,
        protocol: "anthropic-messages",
        baseUrl: "https://api.example.com/v1",
        authType: "api_key",
        apiKey: `sk-${slug}`,
        requestProfile: "standard",
        enabled: true,
        isDefault: false,
        models: [{ id: modelId, contextWindow: 1024 }],
      },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body).id as string;
  }

  it("triggers activateDmMember when model goes from none to set", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const profileId = await seedProfile(ts.port, token, "wake-prov-a", "model-a");

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "wake-bot" },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;

    const patch = await jsonRequest(
      ts.port,
      "PATCH",
      `/api/members/${memberId}`,
      {
        token,
        body: { model: "wake-prov-a/model-a", credentialId: profileId },
      },
    );
    expect(patch.status).toBe(200);
    expect(JSON.parse(patch.body).modelSwitch.model).toBe("wake-prov-a/model-a");
    expect(JSON.parse(patch.body).member.global).toMatchObject({ model: "wake-prov-a/model-a", credentialId: profileId });

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
    const ts0 = Date.now();
    const slugA = `wake-a-${ts0}`;
    const slugB = `wake-b-${ts0}`;
    const profileA = await seedProfile(ts.port, token, slugA, "model-a");
    const profileB = await seedProfile(ts.port, token, slugB, "model-b");

    const created = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "wake-bot-2", model: `${slugA}/model-a`, credentialId: profileA },
    });
    expect(created.status).toBe(200);
    const memberId = JSON.parse(created.body).member.memberId as string;
    activateDmMember.mockClear();

    const patch = await jsonRequest(
      ts.port,
      "PATCH",
      `/api/members/${memberId}`,
      {
        token,
        body: { model: `${slugB}/model-b`, credentialId: profileB },
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
