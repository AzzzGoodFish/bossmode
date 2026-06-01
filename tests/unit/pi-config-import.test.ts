import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let bossmodeDir: string;
let piDir: string;
const oldPiDir = process.env.PI_CODING_AGENT_DIR;

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
});
