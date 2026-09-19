import { describe, expect, it, vi } from "vitest";
import { createTestServer, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("model credential profile API routes", () => {
  it("creates, lists, redacts, lists models, updates, and deletes profiles", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const providerSlug = `openrouter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const create = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles", {
      token,
      body: {
        name: "OpenRouter main",
        providerSlug,
        protocol: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        authType: "api_key",
        apiKey: "sk-secret",
        requestProfile: "standard",
        enabled: true,
        isDefault: true,
        models: [{ id: "anthropic/claude-sonnet", contextWindow: 200000 }],
      },
    });

    expect(create.status).toBe(200);
    const created = JSON.parse(create.body);
    expect(JSON.stringify(created)).not.toContain("sk-secret");
    expect(created.hasSecret).toBe(true);

    const list = await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token });
    expect(list.status).toBe(200);
    expect(list.body).not.toContain("sk-secret");
    const listed = JSON.parse(list.body).find((p: any) => p.id === created.id);
    expect(listed.modelRefs).toEqual([`${providerSlug}/anthropic/claude-sonnet`]);

    const models = await jsonRequest(ts.port, "GET", "/api/available-models", { token });
    expect(models.status).toBe(200);
    expect(JSON.parse(models.body)).toEqual(expect.arrayContaining([expect.objectContaining({ ref: `${providerSlug}/anthropic/claude-sonnet`, profileId: created.id })]));

    const update = await jsonRequest(ts.port, "PUT", `/api/model-credential-profiles/${created.id}`, {
      token,
      body: { ...created, name: "Renamed", authType: "api_key" },
    });
    expect(update.status).toBe(200);
    expect(JSON.parse(update.body).name).toBe("Renamed");

    const del = await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${created.id}`, { token });
    expect(del.status).toBe(200);
    const afterDeleteModels = JSON.parse((await jsonRequest(ts.port, "GET", "/api/available-models", { token })).body);
    expect(afterDeleteModels.find((m: any) => m.profileId === created.id)).toBeUndefined();

    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("validates member credential includes the selected model", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const providerSlug = `openrouter-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const created = JSON.parse((await jsonRequest(ts.port, "POST", "/api/model-credential-profiles", {
      token,
      body: {
        name: "OpenRouter main",
        providerSlug,
        protocol: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        authType: "api_key",
        apiKey: "sk-secret",
        requestProfile: "standard",
        enabled: true,
        isDefault: true,
        models: [{ id: "anthropic/claude-sonnet", contextWindow: 200000 }],
      },
    })).body);

    const ok = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: `dev-${providerSlug}`, model: `${providerSlug}/anthropic/claude-sonnet`, credentialId: created.id, thinkingLevel: "off" },
    });
    expect(ok.status).toBe(200);
    const member = JSON.parse(ok.body).member || JSON.parse(ok.body);
    expect(member.global.credentialId).toBe(created.id);

    await jsonRequest(ts.port, "DELETE", `/api/members/${member.id || member.memberId}`, { token, body: { confirm: true } });
    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${created.id}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });
  it("supports anthropic-messages model discovery via /models endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-4-6", contextWindow: 1000000 } ] }),
    } as any);
    const ts = await createTestServer();
    const token = await login(ts.port);

    const res = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/discover-models", {
      token,
      body: {
        name: "Anthropic Relay",
        providerSlug: "relay",
        protocol: "anthropic-messages",
        baseUrl: "https://api.example.com/v1",
        authType: "api_key",
        apiKey: "sk-secret",
        requestProfile: "standard",
        enabled: true,
        isDefault: false,
        models: [{ id: "placeholder", contextWindow: 1 }],
      },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).models).toEqual([expect.objectContaining({ id: "claude-opus-4-6" })]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-secret" }),
    }));

    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    fetchMock.mockRestore();
  });

  it("preserves missing member model as agent default and rejects incomplete overrides", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const name = `default-model-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const createdRes = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name, thinkingLevel: "off" },
    });
    expect(createdRes.status).toBe(200);
    const created = JSON.parse(createdRes.body).member || JSON.parse(createdRes.body);
    expect(created.global.model ?? null).toBeNull();
    const memberId = created.id || created.memberId;

    // Single-path switch (design-model-switch-single-path-v1 §6): a bare model
    // with no usable credential is rejected, and explicit null is a parameter
    // error — clearing is not a supported action.
    const overrideRes = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { model: "anthropic/claude-sonnet-4-6" },
    });
    expect(overrideRes.status).toBe(400);
    expect(JSON.parse(overrideRes.body).error).toBe("invalid_binding");

    const clearedRes = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { model: null },
    });
    expect(clearedRes.status).toBe(400);
    expect(JSON.parse(clearedRes.body).error).toBe("invalid_model");

    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("rejects a model switch with an explicitly null credential", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const profileA = JSON.parse((await jsonRequest(ts.port, "POST", "/api/model-credential-profiles", {
      token,
      body: {
        name: "Profile A",
        providerSlug: `cloud-a-${Date.now()}`,
        protocol: "anthropic-messages",
        baseUrl: "https://api.example.com/v1",
        authType: "api_key",
        apiKey: "sk-a",
        requestProfile: "standard",
        enabled: true,
        isDefault: false,
        models: [{ id: "model-x", contextWindow: 1024 }],
      },
    })).body);

    const created = JSON.parse((await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: {
        name: `member-${Date.now()}`,
        model: `${profileA.providerSlug}/model-x`,
        credentialId: profileA.id,
        thinkingLevel: "off",
      },
    })).body).member || {};
    const memberId = created.id || created.memberId;

    // A model paired with an explicitly null credential is rejected — the
    // switch requires a complete binding.
    const cleared = await jsonRequest(ts.port, "PATCH", `/api/members/${memberId}`, {
      token,
      body: { model: "other-provider/model-y", credentialId: null },
    });
    expect(cleared.status).toBe(400);
    expect(JSON.parse(cleared.body).error).toBe("invalid_binding");

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${profileA.id}`, { token });
    await jsonRequest(ts.port, "DELETE", `/api/members/${memberId}`, { token, body: { confirm: true } });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("returns validation errors", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);

    const res = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles", {
      token,
      body: { name: "bad", providerSlug: "Bad Slug", protocol: "bad", authType: "api_key", models: [] },
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBeTruthy();
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });
});
