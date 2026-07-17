import { describe, expect, it } from "vitest";
import { availableThinkingLevels, findModelOptionForBinding, ALL_THINKING_LEVELS } from "../../web/src/components/thinking-levels";

const fullLevels = ALL_THINKING_LEVELS.map((l) => l.label);

describe("availableThinkingLevels", () => {
  it("returns all levels when no model is bound", () => {
    expect(availableThinkingLevels(null).map((l) => l.label)).toEqual(fullLevels);
    expect(availableThinkingLevels(undefined).map((l) => l.label)).toEqual(fullLevels);
  });

  it("Opus-style model (map has only xhigh/max) shows all levels — mid levels are available unless explicitly null", () => {
    // Real pi 0.80.10 Opus map: { xhigh: 'xhigh', max: 'max' }.
    // pi's rule: off/minimal/low/medium/high are available by default (absence ≠ disabled).
    const levels = availableThinkingLevels({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } });
    expect(levels.map((l) => l.label)).toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("K3-style model (map has 6 explicit nulls + max) shows only default + max — off is explicitly disabled", () => {
    // Real pi 0.80.10 K3 map: { off:null, minimal:null, low:null, medium:null, high:null, xhigh:null, max:'max' }.
    const levels = availableThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" },
    });
    expect(levels.map((l) => l.label)).toEqual(["default", "max"]);
  });

  it("returns default/off for a reasoning:false model", () => {
    const levels = availableThinkingLevels({ reasoning: false, thinkingLevelMap: undefined });
    expect(levels.map((l) => l.label)).toEqual(["default", "off"]);
  });

  it("reasoning:false wins even if a thinkingLevelMap is present (defensive)", () => {
    const levels = availableThinkingLevels({ reasoning: false, thinkingLevelMap: { max: "max" } });
    expect(levels.map((l) => l.label)).toEqual(["default", "off"]);
  });

  it("custom model without metadata (no map): mid levels available, xhigh/max not (matching pi)", () => {
    const levels = availableThinkingLevels({ reasoning: true, thinkingLevelMap: undefined });
    expect(levels.map((l) => l.label)).toEqual(["default", "off", "minimal", "low", "medium", "high"]);
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

describe("member panel select options (same helpers as ThinkingPop)", () => {
  // Mirrors the exact logic in MemberConfigPanel's Think level <select>:
  // options = availableThinkingLevels(boundModel) minus "default"(null), and the
  // member's currently stored level is prepended if it is not in the available set.
  function selectOptions(boundModel: any, currentThinking: string | undefined) {
    const options = availableThinkingLevels(boundModel).filter((l) => l.value !== null).map((l) => l.value as string);
    const current = currentThinking || "off";
    return options.includes(current) ? options : [current, ...options];
  }

  const opusModel = { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
  const k3Model = { reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" } };
  const nonReasoningModel = { reasoning: false, thinkingLevelMap: undefined };
  const customModel = { reasoning: true, thinkingLevelMap: undefined };

  it("Opus-bound member select shows all levels", () => {
    expect(selectOptions(opusModel, "off")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(selectOptions(opusModel, "medium")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("K3-bound member select shows only max (off is explicitly disabled by K3's map)", () => {
    expect(selectOptions(k3Model, "max")).toEqual(["max"]);
  });

  it("K3-bound member with stored 'off' shows 'off' prepended as the current value", () => {
    expect(selectOptions(k3Model, "off")).toEqual(["off", "max"]);
  });

  it("reasoning:false member select shows only off", () => {
    expect(selectOptions(nonReasoningModel, "off")).toEqual(["off"]);
  });

  it("custom model without metadata shows mid levels but not xhigh/max", () => {
    expect(selectOptions(customModel, "medium")).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("member's stored level not in the available set is still shown as the current value", () => {
    // e.g. member was previously set to "high" while bound to K3 — the select must
    // show "high" as the current value, not silently switch to something else.
    expect(selectOptions(k3Model, "high")).toEqual(["high", "max"]);
  });
});
