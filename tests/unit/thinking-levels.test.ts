import { describe, expect, it } from "vitest";
import { availableThinkingLevels, findModelOptionForBinding, ALL_THINKING_LEVELS } from "../../web/src/components/thinking-levels";

const fullLevels = ALL_THINKING_LEVELS.map((l) => l.label);

describe("availableThinkingLevels", () => {
  it("returns all levels when no model is bound", () => {
    expect(availableThinkingLevels(null).map((l) => l.label)).toEqual(fullLevels);
    expect(availableThinkingLevels(undefined).map((l) => l.label)).toEqual(fullLevels);
  });

  it("returns only default/off/max for a K3-style model with thinkingLevelMap = { max: 'max' }", () => {
    const levels = availableThinkingLevels({ reasoning: true, thinkingLevelMap: { max: "max" } });
    expect(levels.map((l) => l.label)).toEqual(["default", "off", "max"]);
  });

  it("returns default/off plus the mapped subset for a model with several levels", () => {
    const levels = availableThinkingLevels({ reasoning: true, thinkingLevelMap: { low: "low", high: "high" } });
    expect(levels.map((l) => l.label)).toEqual(["default", "off", "low", "high"]);
  });

  it("returns only default/off for a reasoning:false model", () => {
    const levels = availableThinkingLevels({ reasoning: false, thinkingLevelMap: undefined });
    expect(levels.map((l) => l.label)).toEqual(["default", "off"]);
  });

  it("reasoning:false wins even if a thinkingLevelMap is present (defensive)", () => {
    const levels = availableThinkingLevels({ reasoning: false, thinkingLevelMap: { max: "max" } });
    expect(levels.map((l) => l.label)).toEqual(["default", "off"]);
  });

  it("returns all levels for a custom model without thinking metadata", () => {
    const levels = availableThinkingLevels({ reasoning: true, thinkingLevelMap: undefined });
    expect(levels.map((l) => l.label)).toEqual(fullLevels);
  });
});

describe("findModelOptionForBinding", () => {
  const models = [
    { ref: "anthropic/claude-a", provider: "anthropic", providerSlug: "anthropic", modelId: "claude-a", profileId: "cred-a", profileName: "A", protocol: "anthropic-messages", images: false, credentialStatus: "configured" },
    { ref: "anthropic/claude-a", provider: "anthropic", providerSlug: "anthropic", modelId: "claude-a", profileId: "cred-b", profileName: "B", protocol: "anthropic-messages", images: false, credentialStatus: "configured" },
  ] as any[];

  it("returns undefined when model or credential is missing", () => {
    expect(findModelOptionForBinding(null, "cred-a", models)).toBeUndefined();
    expect(findModelOptionForBinding("anthropic/claude-a", null, models)).toBeUndefined();
  });

  it("matches the exact credential + model id, not just the model ref", () => {
    expect(findModelOptionForBinding("anthropic/claude-a", "cred-a", models)?.profileId).toBe("cred-a");
    expect(findModelOptionForBinding("anthropic/claude-a", "cred-b", models)?.profileId).toBe("cred-b");
  });

  it("returns undefined when the credential exists but does not offer that model", () => {
    expect(findModelOptionForBinding("anthropic/claude-other", "cred-a", models)).toBeUndefined();
  });
});
