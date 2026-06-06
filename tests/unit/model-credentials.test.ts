import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

const baseProfile = {
  name: "OpenRouter main",
  providerSlug: "openrouter",
  protocol: "openai-responses" as const,
  baseUrl: "https://openrouter.ai/api/v1",
  authType: "api_key" as const,
  apiKey: "sk-secret",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
  models: [{ id: "anthropic/claude-sonnet", contextWindow: 200000, maxTokens: 64000, input: ["text" as const] }],
};

describe("model credential profiles", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-model-creds-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores profiles in a private file and redacts secrets from public lists", async () => {
    const mod = await import("../../src/engine/model-credentials.js");

    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(saved.hasSecret).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("sk-secret");
    const store = join(dir, "model-credentials.json");
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(readFileSync(store, "utf-8")).toContain("sk-secret");
    expect(mod.listPublicModelCredentialProfiles()[0].modelRefs).toEqual(["openrouter/anthropic/claude-sonnet"]);
  });

  it("validates provider slug, protocol, api key, and model metadata", async () => {
    const mod = await import("../../src/engine/model-credentials.js");

    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, providerSlug: "Bad Slug" })).toThrow("Invalid provider slug");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, protocol: "bad" as any })).toThrow("Unsupported protocol");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, apiKey: undefined })).toThrow("apiKey is required");
    expect(() => mod.saveModelCredentialProfile({ ...baseProfile, models: [{ id: "x", contextWindow: 0 }] })).toThrow("contextWindow");
  });

  it("preserves existing api key on update when omitted and clears it for no-auth", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    mod.saveModelCredentialProfile({ ...baseProfile, id: saved.id, name: "renamed", apiKey: undefined });
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).toContain("sk-secret");

    mod.saveModelCredentialProfile({ ...baseProfile, id: saved.id, authType: "none", apiKey: undefined });
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).not.toContain("sk-secret");
  });

  it("lists credential-backed model options", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(mod.listConfiguredModels()).toMatchObject([
      { ref: "openrouter/anthropic/claude-sonnet", providerSlug: "openrouter", profileId: saved.id, credentialStatus: "configured" },
    ]);
  });

  it("falls back to consistent pi catalog metadata across providers", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    mod.setPiCatalogModelsForTests([
      { provider: "cloud_a", id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["text", "image"] },
      { provider: "opencode", id: "claude-opus-4-6", contextWindow: 1000000, maxTokens: 128000, reasoning: true, input: ["image", "text"] },
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "claude-opus-4-6" }] }),
    } as any);

    const result = await mod.discoverModelCredentialModels({
      name: "Cloud Open",
      providerSlug: "cloud_a",
      protocol: "anthropic-messages",
      baseUrl: "https://api.example.com/v1",
      authType: "api_key",
      apiKey: "sk-secret",
      requestProfile: "standard",
      enabled: true,
      isDefault: false,
      models: [{ id: "placeholder", contextWindow: 1 }],
    });

    expect(result.models).toEqual([
      expect.objectContaining({
        id: "claude-opus-4-6",
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoning: true,
      }),
    ]);

    fetchMock.mockRestore();
  });

  it("allows unknown public context metadata but applies internal pi export fallback", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({ ...baseProfile, models: [{ id: "unknown-model" }] });

    expect(mod.listPublicModelCredentialProfiles()[0].models[0].contextWindow).toBeUndefined();
    expect(mod.listConfiguredModels()[0].contextWindow).toBeUndefined();

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openrouter/unknown-model", credentialId: saved.id });
    const modelsJson = JSON.parse(readFileSync(join(exported!.agentDir, "models.json"), "utf-8"));
    expect(modelsJson.providers.openrouter.models[0].contextWindow).toBe(128000);
  });

  it("exports agent-scoped pi models/auth without leaking api key into models.json", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    const exported = mod.exportPiConfigForMember({ roomId: "room/a", memberName: "dev", modelRef: "openrouter/anthropic/claude-sonnet", credentialId: saved.id });

    expect(exported?.agentDir).toContain(join("pi-agent", "runtime"));
    const modelsJson = readFileSync(join(exported!.agentDir, "models.json"), "utf-8");
    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    expect(modelsJson).toContain("__bossmode_managed_key__");
    expect(modelsJson).not.toContain("sk-secret");
    expect(authJson).toContain("sk-secret");
    expect(statSync(join(exported!.agentDir, "auth.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects credential/model provider mismatch", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile(baseProfile);

    expect(() => mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic/claude-sonnet-4-6", credentialId: saved.id }))
      .toThrow("does not match model provider");
  });

  it("generates an internal extension for anthropic Claude Code/OAuth compatible profiles without embedding the key", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      ...baseProfile,
      providerSlug: "corp-claude",
      protocol: "anthropic-messages",
      requestProfile: "anthropic_claude_code_oauth",
      baseUrl: "https://proxy.example.com",
      models: [{ id: "claude-sonnet", contextWindow: 400000 }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "corp-claude/claude-sonnet", credentialId: saved.id });

    expect(exported?.extensionPaths).toHaveLength(1);
    const ext = readFileSync(exported!.extensionPaths[0], "utf-8");
    expect(ext).toContain("streamSimpleAnthropic");
    expect(ext).not.toContain("sk-secret");
  });

  it("generates an internal anthropic proxy Claude Code adapter with payload/header rewrites", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      ...baseProfile,
      providerSlug: "anthropic-proxy",
      protocol: "anthropic-messages",
      requestProfile: "anthropic_proxy_claude_code",
      baseUrl: "https://console.cloudrouter.online",
      models: [{ id: "claude-sonnet-4-6", contextWindow: 200000 }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "anthropic-proxy/claude-sonnet-4-6", credentialId: saved.id });

    expect(exported?.extensionPaths).toHaveLength(1);
    const modelsJson = readFileSync(join(exported!.agentDir, "models.json"), "utf-8");
    const models = JSON.parse(modelsJson);
    const ext = readFileSync(exported!.extensionPaths[0], "utf-8");
    expect(modelsJson).toContain("anthropic-proxy-claude-code");
    expect(models.providers["anthropic-proxy"].models[0].input).toEqual(["text"]);
    expect(models.providers["anthropic-proxy"].models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(ext).toContain("claude-cli/2.1.122 (external, sdk-cli)");
    expect(ext).toContain("context-1m-2025-08-07");
    expect(ext).toContain("effort-2025-11-24");
    expect(ext).toContain("x-anthropic-billing-header: cc_version=2.1.122.d65; cc_entrypoint=sdk-cli; cch=6b420;");
    expect(ext).toContain("X-Claude-Code-Session-Id");
    expect(ext).toContain("anthropic-beta");
    expect(ext).toContain("onPayload: async");
    expect(ext).toContain("patchClaudeCodePayload");
    expect(ext).toContain("<pi-system-prompt>");
    expect(ext).toContain("device_id: getDeviceId()");
    expect(ext).toContain("account_uuid: \"\"");
    expect(ext).toContain("Authorization: _authorization");
    expect(ext).toContain("authorization: _authorizationLower");
    expect(ext).not.toContain("claude-cli/1.0.0");
    expect(ext).not.toContain("device_id: \"bossmode\"");
    expect(ext).not.toContain("rewriteContext");
    expect(ext).not.toContain("models:");
    expect(ext).not.toContain("__bossmode_managed_key__");
    expect(ext).not.toContain("sk-secret");
  });

  it("keeps newer file OAuth credentials during synced auth overlay and mirrors them to the profile", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "profile-access", refresh: "profile-refresh", expires: 10 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const authPath = join(dir, "runtime-auth.json");
    writeFileSync(authPath, JSON.stringify({
      "openai-codex": { type: "oauth", access: "file-new-access", refresh: "file-new-refresh", expires: 999999 },
    }, null, 2));

    const profile = mod.getModelCredentialProfile(saved.id)!;
    const authStorage = mod.createSyncedAuthStorage(authPath, profile);

    expect(authStorage.get("openai-codex")).toMatchObject({ access: "file-new-access", refresh: "file-new-refresh", expires: 999999 });
    expect(mod.getModelCredentialProfile(saved.id)!.oauthCredentials).toMatchObject({ access: "file-new-access", refresh: "file-new-refresh", expires: 999999 });
  });

  it("persists OAuth refreshes from runtime auth storage back to the Bossmode profile", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "old-access", refresh: "old-refresh", expires: 1 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });
    const profile = mod.getModelCredentialProfile(saved.id)!;
    const authStorage = mod.createSyncedAuthStorage(join(exported!.agentDir, "auth.json"), profile);

    authStorage.set("openai-codex", { type: "oauth", access: "new-access", refresh: "new-refresh", expires: 999999 });

    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(stored.oauthCredentials).toMatchObject({ access: "new-access", refresh: "new-refresh", expires: 999999 });
    expect(readFileSync(join(dir, "model-credentials.json"), "utf-8")).toContain("new-refresh");
  });

  it("overwrites stale per-member OAuth credentials when the profile has a newer reconnect token", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "profile-new-access", refresh: "profile-new-refresh", expires: 999999 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });
    writeFileSync(join(exported!.agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "runtime-old-access", refresh: "runtime-old-refresh", expires: 1 },
    }, null, 2));

    mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });

    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(authJson).toContain("profile-new-refresh");
    expect(authJson).not.toContain("runtime-old-refresh");
    expect(stored.oauthCredentials).toMatchObject({ access: "profile-new-access", refresh: "profile-new-refresh", expires: 999999 });
  });

  it("does not overwrite newer per-member OAuth credentials with stale profile data on export", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      name: "Codex OAuth",
      providerSlug: "openai-codex",
      protocol: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      authType: "oauth",
      oauthProviderId: "openai-codex",
      oauthCredentials: { access: "old-access", refresh: "old-refresh", expires: 1 },
      requestProfile: "openai_codex_subscription",
      enabled: true,
      isDefault: true,
      models: [{ id: "gpt-5-codex", contextWindow: 128000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });
    writeFileSync(join(exported!.agentDir, "auth.json"), JSON.stringify({
      "openai-codex": { type: "oauth", access: "runtime-access", refresh: "runtime-refresh", expires: 999999 },
    }, null, 2));

    mod.exportPiConfigForMember({ roomId: "room", memberName: "dev", modelRef: "openai-codex/gpt-5-codex", credentialId: saved.id });

    const authJson = readFileSync(join(exported!.agentDir, "auth.json"), "utf-8");
    const stored = mod.getModelCredentialProfile(saved.id)!;
    expect(authJson).toContain("runtime-refresh");
    expect(authJson).not.toContain("old-refresh");
    expect(stored.oauthCredentials).toMatchObject({ access: "runtime-access", refresh: "runtime-refresh", expires: 999999 });
  });
});
