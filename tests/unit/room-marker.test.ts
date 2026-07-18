import { describe, expect, it } from "vitest";
import { extractRoomMarkerText } from "../../src/engine/agent-manager.js";

describe("extractRoomMarkerText", () => {
  it("returns the content after [room] + newline, stripped of the marker", () => {
    expect(extractRoomMarkerText("[room]\nFound it — the failure is in the token refresh.")).toBe("Found it — the failure is in the token refresh.");
  });

  it("content before the marker never reaches the room", () => {
    expect(extractRoomMarkerText("Let me check the logs first...\n[room]\nFound it.")).toBe("Found it.");
  });

  it("takes the LAST marker when [room] appears multiple times (no splitting)", () => {
    const text = "Analysis mentions [room] as a concept.\n[room]\nFirst attempt.\nMore reasoning.\n[room]\nFinal answer.";
    expect(extractRoomMarkerText(text)).toBe("Final answer.");
  });

  it("returns null when there is no marker", () => {
    expect(extractRoomMarkerText("Just some reasoning, no marker here.")).toBeNull();
  });

  it("returns null when [room] has no following newline (bare/inline)", () => {
    expect(extractRoomMarkerText("[room] no newline after")).toBeNull();
    expect(extractRoomMarkerText("[room]")).toBeNull();
  });

  it("returns null when the content after the marker is empty/whitespace", () => {
    expect(extractRoomMarkerText("[room]\n   \n  ")).toBeNull();
  });

  it("trims leading/trailing whitespace from the posted body", () => {
    expect(extractRoomMarkerText("[room]\n\n  Padded message.  \n\n")).toBe("Padded message.");
  });

  it("handles CRLF after the marker", () => {
    expect(extractRoomMarkerText("[room]\r\nWindows line ending.")).toBe("Windows line ending.");
  });

  it("returns null for empty text", () => {
    expect(extractRoomMarkerText("")).toBeNull();
  });
});
