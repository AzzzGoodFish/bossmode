import { describe, it, expect } from "vitest";
import { composeManualModelPayload } from "../../web/src/model-helpers.js";

const models = [
  {
    profileId: "p-cloud",
    profileName: "Cloud Online",
    providerSlug: "cloud_online",
  },
  {
    profileId: "p-other",
    profileName: "Other",
    providerSlug: "other",
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
