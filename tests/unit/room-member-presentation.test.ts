import { beforeAll, describe, expect, it } from "vitest";

type MentionPart = { text: string; highlighted: boolean };
let mentionTextParts: (content: string, mentions?: string[]) => MentionPart[];
let compactModelId: (modelRef: string, models: Array<{ ref: string; modelId: string }>) => string;
let memberModelAvailabilityLabel: (modelRef: string | null, credentialId: string | null, models: Array<{ ref: string; profileId: string; modelId: string }>) => string | null;
let memberMcpStatusLabel: (status?: string) => string;
let memberMcpDisplayState: (status: "loading" | "ready" | "error", enabled: boolean, serverCount: number) => string;

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    configurable: true,
  });
  ({ mentionTextParts } = await import("../../web/src/components/MessageBubble.tsx"));
  ({ compactModelId, memberModelAvailabilityLabel, memberMcpStatusLabel, memberMcpDisplayState } = await import("../../web/src/components/member-scope.tsx"));
});

describe("room member presentation", () => {
  it("highlights only exact persisted mentions, including legal member-name punctuation", () => {
    const parts = mentionTextParts(
      "@dev-a @qa_2 @arch.3 @developer @unknown @developerX",
      ["dev", "dev-a", "qa_2", "arch.3", "developer"],
    );

    expect(parts.filter((part) => part.highlighted).map((part) => part.text))
      .toEqual(["@dev-a", "@qa_2", "@arch.3", "@developer"]);
  });

  it("does not render unknown or longer room-chat text as an activated mention", () => {
    expect(mentionTextParts("@unknown", []).some((part) => part.highlighted)).toBe(false);
    expect(mentionTextParts("@dev-a", ["dev"]).some((part) => part.highlighted)).toBe(false);
  });

  it("uses a legal-character lexical fallback only without room metadata", () => {
    expect(mentionTextParts("@dev-a @qa_2 @arch.3").filter((part) => part.highlighted).map((part) => part.text))
      .toEqual(["@dev-a", "@qa_2", "@arch.3"]);
  });

  it("uses a compact model id while preserving safe custom-model fallback", () => {
    expect(compactModelId("openai-codex/gpt-5.6-luna", [])).toBe("gpt-5.6-luna");
    expect(compactModelId("provider/catalog-ref", [{ ref: "provider/catalog-ref", modelId: "catalog-model-id" }])).toBe("catalog-model-id");
    expect(compactModelId("custom/long-model-name", [])).toBe("long-model-name");
    expect(compactModelId("standalone-model", [])).toBe("standalone-model");
  });

  it("marks unconfigured, missing provider connections, and unavailable configured models honestly", () => {
    expect(memberModelAvailabilityLabel("anthropic/claude-sonnet-4-6", null, [])).toBeNull();
    expect(memberModelAvailabilityLabel("anthropic/claude-sonnet-4-6", "profile-1", [])).toBe("No model connected");
    const models = [{ ref: "openai/gpt-5.6-luna", profileId: "profile-1", modelId: "gpt-5.6-luna" }];
    expect(memberModelAvailabilityLabel("openai/gpt-5.6-luna", "profile-1", models)).toBeNull();
    expect(memberModelAvailabilityLabel("anthropic/claude-sonnet-4-6", "profile-1", models)).toBe("claude-sonnet-4-6 · unavailable");
    expect(memberModelAvailabilityLabel("openai/gpt-5.6-luna", "profile-2", models)).toBe("gpt-5.6-luna · unavailable");
  });

  it("keeps MCP loading, error, disabled, empty, and item states mutually exclusive", () => {
    expect(memberMcpDisplayState("loading", false, 0)).toBe("loading");
    expect(memberMcpDisplayState("error", false, 0)).toBe("error");
    expect(memberMcpDisplayState("ready", false, 0)).toBe("disabled");
    expect(memberMcpDisplayState("ready", true, 0)).toBe("empty");
    expect(memberMcpDisplayState("ready", true, 1)).toBe("items");
  });

  it("maps MCP implementation statuses to member-facing labels", () => {
    expect(memberMcpStatusLabel("available")).toBe("Available");
    expect(memberMcpStatusLabel("auth-required")).toBe("Sign-in required");
    expect(memberMcpStatusLabel("invalid-config")).toBe("Needs attention");
    expect(memberMcpStatusLabel("unchecked")).toBe("Not checked");
  });
});
