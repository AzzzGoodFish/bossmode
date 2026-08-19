import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

const customProfile = {
  name: "GLM CloudRouter",
  providerSlug: "qa-custom",
  protocol: "openai-completions" as const,
  baseUrl: "http://127.0.0.1:9/v1",
  authType: "api_key" as const,
  apiKey: "sk-test",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
};

describe("custom endpoint reasoning default", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-reasoning-default-"));
    vi.resetModules();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("save defaults missing reasoning to true", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      ...customProfile,
      models: [{ id: "glm5.3", thinkingLevelMap: { max: "high" } }],
    });
    expect(saved.models[0].reasoning).toBe(true);
  });

  it("save keeps explicit reasoning false", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    const saved = mod.saveModelCredentialProfile({
      ...customProfile,
      models: [{ id: "glm5.3", reasoning: false }],
    });
    expect(saved.models[0].reasoning).toBe(false);
  });

  it("migrates null/missing reasoning on custom_endpoint; leaves builtin catalog flags", async () => {
    const storePath = join(dir, "model-credentials.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, JSON.stringify({
      profiles: [
        {
          id: "cust1",
          profileKind: "custom_endpoint",
          name: "GLM CloudRouter",
          providerSlug: "qa-custom",
          protocol: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          authType: "api_key",
          apiKey: "sk-test",
          requestProfile: "standard",
          enabled: true,
          isDefault: true,
          models: [
            { id: "glm5.3", reasoning: null, thinkingLevelMap: { max: "high" }, metadataSource: "unknown" },
            { id: "other", metadataSource: "unknown" },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "built1",
          profileKind: "builtin_provider",
          name: "Anthropic",
          providerSlug: "anthropic",
          protocol: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          authType: "api_key",
          apiKey: "sk-ant",
          requestProfile: "standard",
          enabled: true,
          isDefault: false,
          models: [{ id: "claude-x", reasoning: false, metadataSource: "pi_catalog" }],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }, null, 2), "utf-8");

    const runtimeDir = join(dir, "pi-agent", "runtime", "roomA", "alice");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "models.json"), JSON.stringify({
      providers: {
        "qa-custom": { models: [{ id: "glm5.3" }] },
      },
    }), "utf-8");

    const mod = await import("../../src/engine/model-credentials.js");
    const loaded = mod.loadModelCredentialProfiles();
    const custom = loaded.find((p) => p.id === "cust1")!;
    expect(custom.models.find((m) => m.id === "glm5.3")?.reasoning).toBe(true);
    expect(custom.models.find((m) => m.id === "other")?.reasoning).toBe(true);

    const persisted = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(persisted.migrations).toContain("custom-endpoint-reasoning-default-v1");
    expect(persisted.profiles.find((p: any) => p.id === "cust1").models[0].reasoning).toBe(true);

    const snaps = readdirSync(join(dir, "pi-agent", "runtime", ".migration-snapshots"));
    expect(snaps.some((n) => n.startsWith("custom-endpoint-reasoning-default-v1-"))).toBe(true);

    const modelsJson = JSON.parse(readFileSync(join(runtimeDir, "models.json"), "utf-8"));
    const glm = modelsJson.providers["qa-custom"].models.find((m: any) => m.id === "glm5.3");
    expect(glm.reasoning).toBe(true);

    const after = readFileSync(storePath, "utf-8");
    mod.loadModelCredentialProfiles();
    expect(readFileSync(storePath, "utf-8")).toBe(after);
  });

  it("does not flip builtin catalog reasoning on refresh", async () => {
    const mod = await import("../../src/engine/model-credentials.js");
    await mod.ensurePiCatalogWarm();
    mod.setPiCatalogModelsForTests([
      { provider: "anthropic", id: "claude-x", name: "Claude X", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", contextWindow: 200000, reasoning: false, input: ["text"] },
    ]);
    const saved = mod.connectBuiltinProviderApiKey({ providerSlug: "anthropic", apiKey: "sk-ant", name: "Anthropic" });
    const model = saved.models.find((m) => m.id === "claude-x");
    expect(model?.reasoning).toBe(false);
    mod.setPiCatalogModelsForTests(null);
  });
});
