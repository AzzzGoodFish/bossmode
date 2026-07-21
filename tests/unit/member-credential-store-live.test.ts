import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;
let boundMember: { id: string; credentialId: string | null; name: string } | null = null;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

vi.mock("../../src/workforce/room-member-resolver.js", () => ({
  resolveRoomMember: (_roomId: string, _ref: string) => boundMember,
}));

describe("member credential store live-read", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-member-cred-"));
    boundMember = null;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the currently bound profile's key and switches on rebinding without recreate", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    await mod.ensurePiCatalogWarm();
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-a", name: "Claude A", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, input: ["text"] },
    ]);
    // Two builtin_provider profiles may share a provider slug (fish's same-provider key switch case).
    const a = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-AAA", name: "Key A" });
    const b = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-BBB", name: "Key B" });

    boundMember = { id: "rm_dev", name: "dev", credentialId: a.id };
    const store = mod.createMemberCredentialStore("room-1", "rm_dev");

    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-AAA" });
    expect(await store.read("openai")).toBeUndefined();

    // Mid-session rebind — next read must return the new key (live resolution).
    boundMember = { id: "rm_dev", name: "dev", credentialId: b.id };
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-BBB" });
    mod.setPiCatalogModelsForTests(null);
  });

  it("returns undefined when bound provider does not match the requested provider (no guessing)", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const a = mod.saveModelCredentialProfile({
      name: "Anthropic",
      providerSlug: "anthropic",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      authType: "api_key",
      apiKey: "sk-ant",
      requestProfile: "standard",
      enabled: true,
      isDefault: true,
      models: [{ id: "claude-a", contextWindow: 200000, input: ["text"] }],
    });
    boundMember = { id: "rm_dev", name: "dev", credentialId: a.id };
    const store = mod.createMemberCredentialStore("room-1", "rm_dev");
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "sk-ant" });
  });

  it("materializes all enabled providers into models.json without secrets", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const openrouter = mod.saveModelCredentialProfile({
      name: "OR",
      providerSlug: "openrouter",
      protocol: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      authType: "api_key",
      apiKey: "sk-or",
      requestProfile: "standard",
      enabled: true,
      isDefault: true,
      models: [{ id: "model-a", contextWindow: 100000, input: ["text"] }],
    });
    mod.saveModelCredentialProfile({
      name: "Proxy",
      providerSlug: "my-proxy",
      protocol: "anthropic-messages",
      baseUrl: "https://proxy.example/anthropic",
      authType: "api_key",
      apiKey: "sk-proxy",
      requestProfile: "standard",
      enabled: true,
      isDefault: false,
      models: [{ id: "claude-x", contextWindow: 200000, input: ["text"] }],
    });

    const exported = mod.exportPiConfigForMember({
      roomId: "room",
      memberName: "dev",
      modelRef: "openrouter/model-a",
      credentialId: openrouter.id,
    });
    const { readFileSync } = await import("node:fs");
    const modelsJson = JSON.parse(readFileSync(`${exported!.agentDir}/models.json`, "utf-8"));
    expect(Object.keys(modelsJson.providers).sort()).toEqual(["my-proxy", "openrouter"]);
    expect(modelsJson.providers.openrouter.apiKey).toBeUndefined();
    expect(modelsJson.providers["my-proxy"].apiKey).toBeUndefined();
    expect(modelsJson.providers["my-proxy"].baseUrl).toContain("proxy.example");
    expect(modelsJson.providers["my-proxy"].models[0].id).toBe("claude-x");
    expect(JSON.stringify(modelsJson)).not.toContain("sk-or");
    expect(JSON.stringify(modelsJson)).not.toContain("sk-proxy");
  });
});
