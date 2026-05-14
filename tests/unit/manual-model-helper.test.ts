import { describe, it, expect } from "vitest";
import {
  composeManualModelPayload,
  inferMemberModelMode,
  getMemberModelBadge,
  shouldUseManualModelInput,
} from "../../web/src/model-helpers.js";

const models = [
  {
    profileId: "p-cloud",
    profileName: "Cloud Online",
    providerSlug: "cloud_online",
    ref: "claude-opus-4-6",
    modelId: "",
    protocol: "openai-completions",
    credentialStatus: "configured",
  },
  {
    profileId: "p-other",
    profileName: "Other",
    providerSlug: "other",
    ref: "gpt-4o",
    modelId: "",
    protocol: "openai-completions",
    credentialStatus: "configured",
  },
] as any[];

describe("composeManualModelPayload", () => {
  it("selected profile + bare id => compose provider/id", () => {
    const result = composeManualModelPayload("claude-opus-4-6", "p-cloud", models);
    expect(result).toEqual({ model: "cloud_online/claude-opus-4-6", credentialId: "p-cloud" });
  });

  it("selected profile + same-provider full ref => pass through", () => {
    const result = composeManualModelPayload("cloud_online/claude-opus-4-6", "p-cloud", models);
    expect(result).toEqual({ model: "cloud_online/claude-opus-4-6", credentialId: "p-cloud" });
  });

  it("selected profile + different full ref => reject even when provider is unconfigured", () => {
    expect(() => composeManualModelPayload("anthropic-proxy/claude-opus-4-6", "p-cloud", models)).toThrow(
      "Manual model provider anthropic-proxy does not match credential provider cloud_online",
    );
  });

  it("no profile + bare id => reject", () => {
    expect(() => composeManualModelPayload("claude-opus-4-6", undefined, models)).toThrow(
      "Manual model without a credential profile must use provider/model format.",
    );
  });

  it("no profile + full ref => pass through", () => {
    const result = composeManualModelPayload("anthropic-proxy/claude-opus-4-6", undefined, models);
    expect(result).toEqual({ model: "anthropic-proxy/claude-opus-4-6", credentialId: null });
  });
});

describe("shouldUseManualModelInput", () => {
  const discoveredModels = [
    { profileId: "p-cloud", profileName: "Cloud Online", providerSlug: "cloud_online", ref: "claude-opus", contextWindow: 1024 },
    { profileId: "p-cloud", profileName: "Cloud Online", providerSlug: "cloud_online", ref: "gpt-4o", contextWindow: 1024 },
    { profileId: "p-alt", profileName: "Alt", providerSlug: "alt", ref: "gpt-4", contextWindow: 1024 },
  ] as any[];

  it("model from configured profile ref should use picker mode", () => {
    expect(shouldUseManualModelInput("claude-opus", "p-cloud", discoveredModels)).toBe(false);
  });

  it("model with missing configured pair should use manual mode", () => {
    expect(shouldUseManualModelInput("unknown", "p-cloud", discoveredModels)).toBe(true);
  });

  it("manual model without credential should stay in manual mode", () => {
    expect(shouldUseManualModelInput("anthropic/claude-opus", undefined, discoveredModels)).toBe(true);
  });

  it("empty model should not force manual mode", () => {
    expect(shouldUseManualModelInput("", undefined, discoveredModels)).toBe(false);
  });
});

describe("inferMemberModelMode + badge", () => {
  it("classifies agent-default", () => {
    expect(inferMemberModelMode(null, null, models)).toBe("agent-default");
    expect(getMemberModelBadge(null, null)).toBe("Agent default");
  });

  it("classifies saved credential model when matched", () => {
    expect(inferMemberModelMode("claude-opus-4-6", "p-cloud", models)).toBe("saved-credential");
    expect(getMemberModelBadge("claude-opus-4-6", "p-cloud")).toBe("Saved credential");
  });

  it("falls back to manual when credential model no longer available", () => {
    expect(inferMemberModelMode("gpt-4.1", "p-missing", models)).toBe("manual-provider-model");
    expect(getMemberModelBadge("anthropic-proxy/claude-opus", null)).toBe("Manual model");
  });
});
