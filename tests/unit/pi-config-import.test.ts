import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let bossmodeDir: string;
let piDir: string;
const oldPiDir = process.env.PI_CODING_AGENT_DIR;
const oldXaiKey = process.env.XAI_API_KEY;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => bossmodeDir,
  ensureBossmodeDir: () => mkdirSync(bossmodeDir, { recursive: true }),
}));

function writePiModels(provider = "testprov", apiKey = "!echo secret") {
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        name: "Test Provider",
        baseUrl: "http://localhost:9999/v1",
        api: "openai-responses",
        apiKey,
        models: [{ id: "model-a", name: "Model A", reasoning: true, input: ["text", "image"], contextWindow: 1000, maxTokens: 200 }],
      },
    },
  }, null, 2));
}

describe("pi config import", () => {
  beforeEach(() => {
    bossmodeDir = mkdtempSync(join(tmpdir(), "bossmode-import-"));
    piDir = mkdtempSync(join(tmpdir(), "pi-agent-import-"));
    process.env.PI_CODING_AGENT_DIR = piDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldPiDir;
    if (oldXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = oldXaiKey;
    rmSync(bossmodeDir, { recursive: true, force: true });
    rmSync(piDir, { recursive: true, force: true });
  });

  it("returns found false when no pi config exists", async () => {
    const { previewPiConfigImport } = await import("../../src/engine/pi-config-import.js");
    expect(previewPiConfigImport()).toMatchObject({ found: false, providers: [] });
  });

  it("previews command apiKey references without exposing or executing them", async () => {
    writePiModels("testprov", "!node -e process.exit(42)");
    const { previewPiConfigImport } = await import("../../src/engine/pi-config-import.js");

    const preview = previewPiConfigImport();

    expect(preview.found).toBe(true);
    expect(preview.providers[0]).toMatchObject({
      providerSlug: "testprov",
      authSource: "models_json_command",
      secretPreview: "!command reference",
      importable: true,
      modelCount: 1,
    });
  });

  it("imports apiKey references verbatim, skips duplicate, and overwrites when requested", async () => {
    writePiModels("testprov", "ENV_TEST_KEY");
    const { importPiConfig } = await import("../../src/engine/pi-config-import.js");

    const first = importPiConfig({});
    expect(first.imported).toHaveLength(1);
    let raw = JSON.parse(readFileSync(join(bossmodeDir, "model-credentials.json"), "utf-8"));
    expect(raw.profiles[0].apiKey).toBe("ENV_TEST_KEY");

    const second = importPiConfig({});
    expect(second.skipped).toEqual([{ providerSlug: "testprov", reason: "already exists" }]);

    writePiModels("testprov", "!cat /tmp/key");
    const third = importPiConfig({ overwriteProviderSlugs: ["testprov"] });
    expect(third.overwritten).toHaveLength(1);
    raw = JSON.parse(readFileSync(join(bossmodeDir, "model-credentials.json"), "utf-8"));
    expect(raw.profiles[0].apiKey).toBe("!cat /tmp/key");
  });

  it("available models are sourced from Bossmode credentials, not legacy pi config alone", async () => {
    writePiModels("testprov", "ENV_TEST_KEY");
    const { listAvailableModels } = await import("../../src/engine/model-credentials.js");
    const { importPiConfig } = await import("../../src/engine/pi-config-import.js");

    expect(listAvailableModels()).toEqual([]);
    importPiConfig({});
    expect(listAvailableModels().map((m) => m.ref)).toEqual(["testprov/model-a"]);
  });

  it("imports anthropic-proxy Claude Code protocol as a Bossmode compatibility profile", async () => {
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "models.json"), JSON.stringify({
      providers: {
        "anthropic-proxy": {
          name: "Anthropic Proxy",
          baseUrl: "https://console.cloudrouter.online",
          api: "anthropic-proxy-claude-code",
          apiKey: "!cat /tmp/anthropic-proxy-key",
          authHeader: true,
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text"], contextWindow: 200000 }],
        },
      },
    }, null, 2));
    const { previewPiConfigImport, importPiConfig } = await import("../../src/engine/pi-config-import.js");

    const preview = previewPiConfigImport();
    expect(preview.providers[0]).toMatchObject({
      providerSlug: "anthropic-proxy",
      protocol: "anthropic-messages",
      authSource: "models_json_command",
      importable: true,
      warnings: [],
    });

    expect(importPiConfig({}).imported).toHaveLength(1);
    const raw = JSON.parse(readFileSync(join(bossmodeDir, "model-credentials.json"), "utf-8"));
    expect(raw.profiles[0]).toMatchObject({
      providerSlug: "anthropic-proxy",
      protocol: "anthropic-messages",
      requestProfile: "anthropic_proxy_claude_code",
      authHeader: true,
      apiKey: "!cat /tmp/anthropic-proxy-key",
    });
  });

  it("imports environment-backed xAI credentials by env var reference", async () => {
    process.env.XAI_API_KEY = "xai-secret-for-test";
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "models.json"), JSON.stringify({
      providers: {
        xai: {
          name: "xAI",
          baseUrl: "https://api.x.ai/v1",
          api: "openai-responses",
          models: [{ id: "grok-4", name: "Grok 4", input: ["text"] }],
        },
      },
    }, null, 2));
    const { previewPiConfigImport, importPiConfig } = await import("../../src/engine/pi-config-import.js");

    const preview = previewPiConfigImport();
    expect(preview.providers[0]).toMatchObject({
      providerSlug: "xai",
      authSource: "environment",
      secretPreview: "XAI_API_KEY",
      importable: true,
    });

    expect(importPiConfig({}).imported).toHaveLength(1);
    const raw = JSON.parse(readFileSync(join(bossmodeDir, "model-credentials.json"), "utf-8"));
    expect(raw.profiles[0].apiKey).toBe("XAI_API_KEY");
    expect(readFileSync(join(bossmodeDir, "model-credentials.json"), "utf-8")).not.toContain("xai-secret-for-test");
    delete process.env.XAI_API_KEY;
  });
});
