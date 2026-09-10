import { describe, expect, it, vi } from "vitest";
import { createTestServer, closeTestServer, jsonRequest, setupTestWorkspace } from "../helpers/test-server.js";

setupTestWorkspace();

async function login(port: number): Promise<string> {
  const res = await jsonRequest(port, "POST", "/api/auth/login", { body: { username: "testuser", password: "testpass" } });
  expect(res.status).toBe(200);
  return JSON.parse(res.body).token;
}

/** Fire-and-forget submit (2026-09-05): submit returns the current snapshot
 * immediately — poll the job like the client does until it settles. */
async function pollJobUntilSettled(port: number, token: string, jobId: string, timeoutMs = 5000): Promise<any> {
  const started = Date.now();
  for (;;) {
    const res = await jsonRequest(port, "GET", `/api/model-credential-profiles/oauth/${jobId}`, { token });
    expect(res.status).toBe(200);
    const job = JSON.parse(res.body);
    if (job.status === "completed" || job.status === "failed") return job;
    if (Date.now() - started > timeoutMs) throw new Error(`oauth job ${jobId} did not settle: ${job.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("model credential profile API routes", () => {

  it.each(["complete", "cancel"])("acknowledges input while token exchange is pending, then %s via job state", async (action) => {
    const { setOAuthLoginAdapterForTests, setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([{ provider: "anthropic", id: "claude-fable-5", name: "Fixture model", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"] }]);
    let release!: () => void;
    let returned!: () => void;
    const exchange = new Promise<void>((resolve) => { release = resolve; });
    const providerReturned = new Promise<void>((resolve) => { returned = resolve; });
    setOAuthLoginAdapterForTests({ async login(_provider, callbacks) {
      await callbacks.onManualCodeInput!();
      await exchange; // Deliberately remains pending after the HTTP submit returns.
      returned();
      return { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600000 };
    } });
    const ts = await createTestServer();
    try {
      const token = await login(ts.port);
      const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth/start", { token, body: { providerId: "anthropic", name: `Pending ${action} fixture` } });
      expect(start.status).toBe(200);
      const job = JSON.parse(start.body);
      const input = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth/${job.id}/input`, { token, body: { code: "fixture-code" } });
      expect(input.status).toBe(200);
      expect(JSON.parse(input.body).status).toBe("starting");
      expect(input.body).not.toContain("fixture-access");
      const pending = await jsonRequest(ts.port, "GET", `/api/model-credential-profiles/oauth/${job.id}`, { token });
      expect(JSON.parse(pending.body).status).toBe("starting");
      const duplicate = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth/${job.id}/input`, { token, body: { code: "fixture-code" } });
      expect(duplicate.status).toBe(400);
      expect(duplicate.body).toContain("not waiting for input");
      if (action === "cancel") {
        const cancel = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth/${job.id}/cancel`, { token });
        expect(cancel.status).toBe(200);
        expect(JSON.parse(cancel.body).status).toBe("cancelled");
      }
      release();
      await providerReturned;
      const final = action === "complete"
        ? await pollJobUntilSettled(ts.port, token, job.id)
        : JSON.parse((await jsonRequest(ts.port, "GET", `/api/model-credential-profiles/oauth/${job.id}`, { token })).body);
      expect(final.status).toBe(action === "complete" ? "completed" : "cancelled");
      expect(JSON.stringify(final)).not.toContain("fixture-access");
      expect(JSON.stringify(final)).not.toContain("fixture-refresh");
      const profiles = JSON.parse((await jsonRequest(ts.port, "GET", "/api/model-credential-profiles", { token })).body);
      expect(profiles.some((profile: any) => profile.name === `Pending ${action} fixture`)).toBe(action === "complete");
    } finally {
      release();
      setOAuthLoginAdapterForTests(null);
      await closeTestServer(ts);
    }
  });

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
    expect(input.status).toBe(200); // fire-and-forget: accepts immediately
    const completed = await pollJobUntilSettled(ts.port, token, job.id);
    expect(completed.status).toBe("completed");

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
    expect(input.status).toBe(200); // fire-and-forget: accepts immediately
    expect(input.body).not.toContain("native-access-token");
    const completed = await pollJobUntilSettled(ts.port, token, job.id);
    expect(completed.status).toBe("completed");
    expect(JSON.stringify(completed)).not.toContain("native-access-token");

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

  // fish 2026-09-04: Codex login opens with a select prompt (browser vs device
  // code). The job must expose it as structured options (the UI renders them
  // as buttons and submits the option ID), and the selectPrompt must be
  // cleared once the flow moves on — otherwise stale buttons linger over the
  // next stage.
  it("exposes select prompts and clears them when the flow advances", async () => {
    const { setOAuthLoginAdapterForTests, setPiCatalogModelsForTests } = await import("../../src/engine/model-credentials.js");
    setPiCatalogModelsForTests([
      { provider: "openai-codex", id: "gpt-5-codex", name: "GPT-5 Codex", api: "openai-responses", baseUrl: "https://api.openai.com", contextWindow: 128000, input: ["text"] },
    ]);
    let releaseDeviceStage!: () => void;
    const deviceGate = new Promise<void>((r) => { releaseDeviceStage = r; });
    setOAuthLoginAdapterForTests({
      async login(_providerId, callbacks) {
        const choice = await callbacks.onSelect({
          message: "How do you want to sign in?",
          options: [
            { id: "browser", label: "Sign in with browser" },
            { id: "device_code", label: "Sign in with device code" },
          ],
        });
        expect(choice).toBe("device_code"); // the option id, never the label
        callbacks.onDeviceCode?.({ userCode: "WXYZ-9876", verificationUri: "https://auth.openai.com/codex/device", expiresInSeconds: 900, intervalSeconds: 5 });
        await deviceGate; // hold the device stage so we can inspect the job mid-flow
        return { access: "codex-access", refresh: "codex-refresh", expires: Date.now() + 3600_000 };
      },
    });
    const ts = await createTestServer();
    const token = await login(ts.port);

    const start = await jsonRequest(ts.port, "POST", "/api/model-credential-profiles/oauth/start", { token, body: { providerId: "openai-codex" } });
    expect(start.status).toBe(200);
    const job = JSON.parse(start.body);
    expect(job.status).toBe("awaiting_input");
    expect(job.selectPrompt).toEqual({
      message: "How do you want to sign in?",
      options: [
        { id: "browser", label: "Sign in with browser" },
        { id: "device_code", label: "Sign in with device code" },
      ],
    });

    // Fire-and-forget submit: the response is the accepted snapshot; the
    // flow advances underneath and the poller sees the settled state.
    const submit = await jsonRequest(ts.port, "POST", `/api/model-credential-profiles/oauth/${job.id}/input`, { token, body: { code: "device_code" } });
    expect(submit.status).toBe(200);
    const mid = JSON.parse((await jsonRequest(ts.port, "GET", `/api/model-credential-profiles/oauth/${job.id}`, { token })).body);
    expect(mid.status).toBe("awaiting_device");
    expect(mid.selectPrompt).toBeUndefined();
    expect(mid.deviceCode).toEqual(expect.objectContaining({ userCode: "WXYZ-9876" }));

    releaseDeviceStage();
    const done = await pollJobUntilSettled(ts.port, token, job.id);
    expect(done.status).toBe("completed");
    expect(done.selectPrompt).toBeUndefined();

    await jsonRequest(ts.port, "DELETE", `/api/model-credential-profiles/${done.profileId}`, { token });
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
    expect(input.status).toBe(200); // fire-and-forget: accepts immediately
    expect(input.body).not.toContain("provider-access-token");
    expect(input.body).not.toContain("provider-refresh-token");
    const completed = await pollJobUntilSettled(ts.port, token, job.id);
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
    expect(input.status).toBe(200); // fire-and-forget: accepts immediately
    const failed = await pollJobUntilSettled(ts.port, token, job.id);
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
