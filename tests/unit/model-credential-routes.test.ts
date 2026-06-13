import { describe, expect, it, vi } from "vitest";
import { createTestServer, jsonRequest, setupConfigMock } from "../helpers/test-server.js";

setupConfigMock();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

describe("model credential profile API routes", () => {

  it("runs native Anthropic OAuth connection and normalizes legacy request profile to standard", async () => {
    const { setOAuthLoginAdapterForTests, setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"], compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "xhigh" } },
    ]);
    setOAuthLoginAdapterForTests({
      async login(providerId, callbacks) {
        callbacks.onAuth({ url: `https://provider.example/${providerId}/authorize`, instructions: "Authorize with provider." });
        const code = await callbacks.onManualCodeInput!();
        if (code !== "valid-anthropic-code") throw new Error("invalid code");
        return { access: "anthropic-access-token", refresh: "anthropic-refresh-token", expires: Date.now() + 3600_000 };
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);

    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth/start", {
      token,
      body: { providerId: "anthropic", name: "Anthropic Enhanced" },
    });
    expect(start.status).toBe(200);
    const job = JSON.parse(start.body);

    const input = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth/${job.id}/input`, { token, body: { code: "valid-anthropic-code" } });
    expect(input.status).toBe(200);
    const completed = JSON.parse(input.body);

    const profiles = JSON.parse((await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token })).body);
    const saved = profiles.find((pr: any) => pr.id === completed.profileId);
    expect(saved).toEqual(expect.objectContaining({
      profileKind: "builtin_provider",
      providerSlug: "anthropic",
      authType: "oauth",
      oauthProviderId: "anthropic",
      requestProfile: "standard",
      hasSecret: true,
    }));
    expect(saved.modelRefs).toEqual(["anthropic/claude-fable-5"]);

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${completed.profileId}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    setOAuthLoginAdapterForTests(null);
    setPiCatalogModelsForTests(null);
  });

  it("runs native OAuth provider connection without custom endpoint fields", async () => {
    const { setOAuthLoginAdapterForTests, setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([
      { provider: "openai-codex", id: "gpt-5-codex", name: "GPT-5 Codex", api: "openai-codex-responses", baseUrl: "https://api.openai.com/v1", contextWindow: 128000, input: ["text"] },
    ]);
    setOAuthLoginAdapterForTests({
      async login(providerId, callbacks) {
        callbacks.onAuth({ url: `https://provider.example/${providerId}/authorize`, instructions: "Authorize with provider." });
        const code = await callbacks.onManualCodeInput!();
        if (code !== "valid-native-code") throw new Error("Failed to extract accountId from token");
        return { access: "native-access-token", refresh: "native-refresh-token", expires: Date.now() + 3600_000, accountId: "acct_native" };
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);

    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth/start", {
      token,
      body: { providerId: "openai-codex", name: "Codex Native" },
    });
    expect(start.status).toBe(200);
    const job = JSON.parse(start.body);
    expect(job.status).toBe("awaiting_input");
    expect(job.authUrl).toBeTruthy();

    const input = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth/${job.id}/input`, { token, body: { code: "valid-native-code" } });
    expect(input.status).toBe(200);
    expect(input.body).not.toContain("native-access-token");
    const completed = JSON.parse(input.body);
    expect(completed.status).toBe("completed");

    const profiles = JSON.parse((await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token })).body);
    const saved = profiles.find((pr: any) => pr.id === completed.profileId);
    expect(saved).toEqual(expect.objectContaining({
      profileKind: "builtin_provider",
      name: "Codex Native",
      providerSlug: "openai-codex",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      hasSecret: true,
    }));
    expect(saved.modelRefs).toEqual(["openai-codex/gpt-5-codex"]);

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${completed.profileId}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    setOAuthLoginAdapterForTests(null);
    setPiCatalogModelsForTests(null);
  });

  it("surfaces device-code OAuth jobs for polling", async () => {
    const { setOAuthLoginAdapterForTests, setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([
      { provider: "github-copilot", id: "claude-sonnet-4", name: "Claude Sonnet", api: "openai-responses", baseUrl: "https://api.githubcopilot.com", contextWindow: 128000, input: ["text"] },
    ]);
    setOAuthLoginAdapterForTests({
      async login(_providerId, callbacks) {
        callbacks.onDeviceCode?.({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresInSeconds: 900, intervalSeconds: 5 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { access: "device-access", refresh: "device-refresh", expires: Date.now() + 3600_000 };
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);

    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth/start", { token, body: { providerId: "github-copilot" } });
    expect(start.status).toBe(200);
    const job = JSON.parse(start.body);
    expect(job.status).toBe("awaiting_device");
    expect(job.deviceCode).toEqual(expect.objectContaining({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }));

    await new Promise((resolve) => setTimeout(resolve, 80));
    const polled = JSON.parse((await jsonRequest(ts.port, "GET", `/api/model-credential-profiles/oauth/${job.id}`, { token })).body);
    expect(polled.status).toBe("completed");
    expect(polled.profileId).toBeTruthy();

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${polled.profileId}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    setOAuthLoginAdapterForTests(null);
    setPiCatalogModelsForTests(null);
  });

  it("connects a built-in provider API key through native Connect Provider endpoints", async () => {
    const { setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([
      { provider: "openai", id: "gpt-4.1", name: "GPT 4.1", api: "openai-responses", baseUrl: "https://api.openai.com/v1", contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ["text", "image"] },
      { provider: "openai", id: "gpt-4.1-mini", name: "GPT 4.1 Mini", api: "openai-responses", baseUrl: "https://api.openai.com/v1", contextWindow: 1000000, input: ["text"] },
    ]);
    const ts = await createTestServer();
    const token = await login(ts.port);

    const catalog = await jsonRequest(ts.port, "GET", "/api/model-provider-catalog", { token });
    expect(catalog.status).toBe(200);
    expect(JSON.parse(catalog.body)).toEqual(expect.arrayContaining([expect.objectContaining({ providerSlug: "openai", modelCount: 2 })]));

    const connected = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/connect-api-key", {
      token,
      body: { providerSlug: "openai", apiKey: "sk-openai", isDefault: true },
    });
    expect(connected.status).toBe(200);
    const profile = JSON.parse(connected.body);
    expect(profile.profileKind).toBe("builtin_provider");
    expect(profile.modelRefs).toEqual(["openai/gpt-4.1", "openai/gpt-4.1-mini"]);
    expect(connected.body).not.toContain("sk-openai");

    const models = JSON.parse((await jsonRequest(ts.port, "GET", "/api/models", { token })).body);
    expect(models).toEqual(expect.arrayContaining([expect.objectContaining({ ref: "openai/gpt-4.1", profileId: profile.id })]));

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${profile.id}`, { token });
    setPiCatalogModelsForTests(null);
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });
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

    const models = await jsonRequest(ts.port, "GET", "/api/models", { token });
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
    const afterDeleteModels = JSON.parse((await jsonRequest(ts.port, "GET", "/api/models", { token })).body);
    expect(afterDeleteModels.find((m: any) => m.profileId === created.id)).toBeUndefined();

    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("validates member credential provider against selected model", async () => {
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
      body: { name: `dev-${providerSlug}`, agent: "developer", model: `${providerSlug}/anthropic/claude-sonnet`, runtime: "pi-cli", credentialId: created.id, thinkingLevel: "off" },
    });
    expect(ok.status).toBe(200);
    const member = JSON.parse(ok.body);
    expect(member.credentialId).toBe(created.id);

    const mismatch = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name: "bad", agent: "developer", model: "anthropic/claude-sonnet-4-6", runtime: "pi-cli", credentialId: created.id, thinkingLevel: "off" },
    });
    expect(mismatch.status).toBe(400);
    expect(JSON.parse(mismatch.body).error).toContain("does not match model provider");

    await jsonRequest(ts.port, "DELETE", `/api/members/${member.id}`, { token });
    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${created.id}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("discovers OpenAI-compatible models without leaking secrets", async () => {
    const { setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests(null);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini", name: "GPT 4.1 Mini" }, { noId: true }] }),
    } as any);
    const ts = await createTestServer();
    const token = await login(ts.port);

    const res = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/discover-models", {
      token,
      body: {
        name: "OpenAI",
        providerSlug: "openai-test",
        protocol: "openai-responses",
        baseUrl: "https://api.example.com/v1",
        authType: "api_key",
        apiKey: "sk-secret-discovery",
        requestProfile: "standard",
        enabled: true,
        isDefault: false,
        models: [{ id: "placeholder", contextWindow: 1 }],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).not.toContain("sk-secret-discovery");
    const body = JSON.parse(res.body);
    expect(body.models).toEqual([
      expect.objectContaining({ id: "gpt-4.1", metadataSource: "unknown" }),
      expect.objectContaining({ id: "gpt-4.1-mini", name: "GPT 4.1 Mini" }),
    ]);
    expect(body.models[0].input).toBeUndefined();
    expect(body.models[0].contextWindow).toBeUndefined();
    expect(body.partial).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-secret-discovery" }),
    }));

    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    fetchMock.mockRestore();
  });

  it("uses endpoint metadata before pi catalog fallback during discovery", async () => {
    const { setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([{ provider: "openai-test", id: "gpt-known", contextWindow: 999000, maxTokens: 999, reasoning: false }]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-known", context_window: 64000, max_output_tokens: 8192, supports_reasoning: true }] }) } as any);
    const ts = await createTestServer();
    const token = await login(ts.port);
    const res = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/discover-models", { token, body: { name: "OpenAI", providerSlug: "openai-test", protocol: "openai-responses", baseUrl: "https://api.example.com/v1", authType: "api_key", apiKey: "sk-secret", models: [{ id: "placeholder" }] } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).models[0]).toEqual(expect.objectContaining({ id: "gpt-known", contextWindow: 64000, maxTokens: 8192, reasoning: true, metadataSource: "endpoint" }));
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    fetchMock.mockRestore();
    setPiCatalogModelsForTests(null);
  });

  it("falls back to unique pi catalog metadata and keeps unknown when unmatched", async () => {
    const { setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([{ provider: "openai-test", id: "gpt-known", contextWindow: 200000, maxTokens: 32000, reasoning: true }]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-known" }, { id: "unknown-model" }] }) } as any);
    const ts = await createTestServer();
    const token = await login(ts.port);
    const res = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/discover-models", { token, body: { providerSlug: "openai-test", protocol: "openai-responses", baseUrl: "https://api.example.com/v1", authType: "api_key", apiKey: "sk-secret", models: [{ id: "placeholder" }] } });
    expect(res.status).toBe(200);
    const models = JSON.parse(res.body).models;
    expect(models.find((m: any) => m.id === "gpt-known")).toEqual(expect.objectContaining({ contextWindow: 200000, maxTokens: 32000, reasoning: true, metadataSource: "pi_catalog" }));
    expect(models.find((m: any) => m.id === "unknown-model")).toEqual(expect.objectContaining({ metadataSource: "unknown" }));
    expect(models.find((m: any) => m.id === "unknown-model").contextWindow).toBeUndefined();
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    fetchMock.mockRestore();
    setPiCatalogModelsForTests(null);
  });

  it("runs OAuth login jobs through an adapter exchange and redacts stored tokens", async () => {
    const { setOAuthLoginAdapterForTests } = await import("../../src/engine/model-credentials.js");
    setOAuthLoginAdapterForTests({
      async login(providerId, callbacks) {
        callbacks.onAuth({ url: `https://provider.example/${providerId}/authorize`, instructions: "Authorize with provider." });
        const code = await callbacks.onManualCodeInput!();
        if (code !== "valid-provider-code") throw new Error("invalid_grant");
        return { access: "provider-access-token", refresh: "provider-refresh-token", expires: Date.now() + 3600_000, accountId: "acct_1" };
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);
    const providerSlug = `oauth-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth-login/start", {
      token,
      body: {
        providerId: "openai-codex",
        profile: {
          name: "Codex OAuth",
          providerSlug,
          protocol: "openai-codex-responses",
          baseUrl: "https://api.example.com/v1",
          authType: "oauth",
          oauthProviderId: "openai-codex",
          requestProfile: "standard",
          enabled: true,
          isDefault: false,
          models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
        },
      },
    });
    expect(start.status).toBe(200);
    const job = JSON.parse(start.body);
    expect(job.status).toBe("awaiting_input");
    expect(job.authUrl).toBeTruthy();

    const input = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth-login/${job.id}/input`, {
      token,
      body: { code: "valid-provider-code" },
    });
    expect(input.status).toBe(200);
    expect(input.body).not.toContain("provider-access-token");
    expect(input.body).not.toContain("provider-refresh-token");
    const completed = JSON.parse(input.body);
    expect(completed.status).toBe("completed");
    expect(completed.profileId).toBeTruthy();

    const profiles = await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token });
    expect(profiles.body).not.toContain("provider-access-token");
    expect(profiles.body).not.toContain("provider-refresh-token");
    const saved = JSON.parse(profiles.body).find((p: any) => p.id === completed.profileId);
    expect(saved.hasSecret).toBe(true);
    expect(saved.authType).toBe("oauth");

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${completed.profileId}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    setOAuthLoginAdapterForTests(null);
  });

  it("rejects invalid OAuth exchange input without saving a profile", async () => {
    const { setOAuthLoginAdapterForTests } = await import("../../src/engine/model-credentials.js");
    setOAuthLoginAdapterForTests({
      async login(_providerId, callbacks) {
        callbacks.onAuth({ url: "https://provider.example/authorize", instructions: "Authorize with provider." });
        const code = await callbacks.onManualCodeInput!();
        throw new Error(code === "bad-code" ? "invalid_grant" : "unexpected code");
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);
    const providerSlug = `oauth-invalid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth-login/start", {
      token,
      body: { providerId: "openai-codex", profile: { name: "Bad OAuth", providerSlug, protocol: "openai-codex-responses", baseUrl: "https://api.example.com/v1", authType: "oauth", oauthProviderId: "openai-codex", requestProfile: "standard", enabled: true, isDefault: false, models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }] } },
    });
    const job = JSON.parse(start.body);
    const input = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth-login/${job.id}/input`, { token, body: { code: "bad-code" } });
    expect(input.status).toBe(200);
    const failed = JSON.parse(input.body);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("请在 Settings 重新连接");
    expect(failed.error).not.toContain("invalid_grant");
    const profiles = JSON.parse((await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token })).body);
    expect(profiles.find((p: any) => p.providerSlug === providerSlug)).toBeUndefined();
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    setOAuthLoginAdapterForTests(null);
  });

  it("cancels OAuth login jobs without saving partial credentials", async () => {
    const { setOAuthLoginAdapterForTests } = await import("../../src/engine/model-credentials.js");
    setOAuthLoginAdapterForTests({
      async login(_providerId, callbacks) {
        callbacks.onAuth({ url: "https://provider.example/authorize", instructions: "Authorize with provider." });
        await callbacks.onManualCodeInput!();
        return { access: "should-not-save", refresh: "should-not-save", expires: Date.now() + 3600_000 };
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);
    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth-login/start", {
      token,
      body: {
        providerId: "anthropic",
        profile: {
          name: "Anthropic OAuth",
          providerSlug: `anthropic-oauth-${Date.now()}`,
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          authType: "oauth",
          oauthProviderId: "anthropic",
          requestProfile: "standard",
          enabled: true,
          isDefault: false,
          models: [{ id: "claude", contextWindow: 128000, input: ["text"] }],
        },
      },
    });
    const job = JSON.parse(start.body);
    const cancel = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth-login/${job.id}/cancel`, { token });
    expect(cancel.status).toBe(200);
    expect(JSON.parse(cancel.body).status).toBe("cancelled");
    const input = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth-login/${job.id}/input`, { token, body: { code: "late" } });
    expect(input.status).toBe(400);
    expect(JSON.parse(input.body).error).toContain("cancelled");
    const profiles = JSON.parse((await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token })).body);
    expect(profiles.find((p: any) => p.name === "Anthropic OAuth")).toBeUndefined();
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
    setOAuthLoginAdapterForTests(null);
  });

  it("rejects incomplete OAuth profiles and does not list unusable models", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const providerSlug = `incomplete-oauth-${Date.now()}`;
    const create = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles", {
      token,
      body: { name: "Incomplete OAuth", providerSlug, protocol: "openai-codex-responses", baseUrl: "https://api.example.com/v1", authType: "oauth", oauthProviderId: "openai-codex", requestProfile: "standard", enabled: true, isDefault: false, models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }] },
    });
    expect(create.status).toBe(400);
    expect(JSON.parse(create.body).error).toContain("OAuth credential is incomplete");
    const models = JSON.parse((await jsonRequest(ts.port, "GET", "/api/models", { token })).body);
    expect(models.find((m: any) => m.providerSlug === providerSlug)).toBeUndefined();
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

  it("preserves missing member model as agent default and can clear an existing override", async () => {
    const ts = await createTestServer();
    const token = await login(ts.port);
    const name = `default-model-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const createdRes = await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: { name, agent: "developer", runtime: "pi-cli", thinkingLevel: "off" },
    });
    expect(createdRes.status).toBe(200);
    const created = JSON.parse(createdRes.body);
    expect(created.model).toBeUndefined();

    const overrideRes = await jsonRequest(ts.port, "PUT", `/api/members/${created.id}`, {
      token,
      body: { model: "anthropic/claude-sonnet-4-6" },
    });
    expect(overrideRes.status).toBe(200);
    expect(JSON.parse(overrideRes.body).model).toBe("anthropic/claude-sonnet-4-6");

    const clearedRes = await jsonRequest(ts.port, "PUT", `/api/members/${created.id}`, {
      token,
      body: { model: null },
    });
    expect(clearedRes.status).toBe(200);
    expect(JSON.parse(clearedRes.body).model).toBeUndefined();

    await jsonRequest(ts.port, "DELETE", `/api/members/${created.id}`, { token });
    await new Promise<void>((resolve) => ts.server.close(() => resolve()));
  });

  it("clears stale credential when explicitly set to null", async () => {
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

    const member = JSON.parse((await jsonRequest(ts.port, "POST", "/api/members", {
      token,
      body: {
        name: `member-${Date.now()}`,
        agent: "developer",
        model: `${profileA.providerSlug}/model-x`,
        runtime: "pi-cli",
        credentialId: profileA.id,
        thinkingLevel: "off",
      },
    })).body);

    const noClear = await jsonRequest(ts.port, "PUT", `/api/members/${member.id}`, {
      token,
      body: { model: "other-provider/model-y" },
    });
    expect(noClear.status).toBe(400);
    expect(JSON.parse(noClear.body).error).toContain("does not match model provider");

    const cleared = await jsonRequest(ts.port, "PUT", `/api/members/${member.id}`, {
      token,
      body: { model: "other-provider/model-y", credentialId: null },
    });
    expect(cleared.status).toBe(200);
    const clearedBody = JSON.parse(cleared.body);
    expect(clearedBody.model).toBe("other-provider/model-y");
    expect(clearedBody.credentialId).toBeUndefined();

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${profileA.id}`, { token });
    await jsonRequest(ts.port, "DELETE", `/api/members/${member.id}`, { token });
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
