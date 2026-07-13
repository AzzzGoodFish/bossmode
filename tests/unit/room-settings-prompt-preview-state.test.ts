import { beforeAll, describe, expect, it, vi } from "vitest";

let promptPreviewDisplayState: typeof import("../../web/src/components/RoomSettingsDialog.js").promptPreviewDisplayState;

beforeAll(async () => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  ({ promptPreviewDisplayState } = await import("../../web/src/components/RoomSettingsDialog.js"));
});

const supplement = (content: string) => ({ content, revision: 1, contentHash: "hash", contentLength: content.length });

describe("Room Settings shared-guidance preview state", () => {
  it("keeps loading, successful empty, loaded, and error states mutually exclusive", () => {
    expect(promptPreviewDisplayState({ status: "loading" })).toBe("loading");
    expect(promptPreviewDisplayState({ status: "ready", supplement: supplement("") })).toBe("empty");
    expect(promptPreviewDisplayState({ status: "ready", supplement: supplement("# Guidance") })).toBe("loaded");
    expect(promptPreviewDisplayState({ status: "error" })).toBe("error");
  });

  it("models error to Retry recovery without passing through a false empty state", () => {
    expect(promptPreviewDisplayState({ status: "error" })).toBe("error");
    expect(promptPreviewDisplayState({ status: "loading" })).toBe("loading");
    expect(promptPreviewDisplayState({ status: "ready", supplement: supplement("Recovered") })).toBe("loaded");
  });
});
