import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActivationSource,
  clearAllActivationSources,
  getActivationSource,
  setActivationSource,
} from "../../src/engine/activation-context.js";

describe("activation-context", () => {
  afterEach(() => {
    clearAllActivationSources();
    vi.useRealTimers();
  });

  it("set/get roundtrip", () => {
    setActivationSource("r1", "pm", "room_mention");
    expect(getActivationSource("r1", "pm")).toBe("room_mention");
  });

  it("overwrite returns latest source", () => {
    setActivationSource("r1", "pm", "room_mention");
    setActivationSource("r1", "pm", "private_instruction");
    expect(getActivationSource("r1", "pm")).toBe("private_instruction");
  });

  it("clear removes source", () => {
    setActivationSource("r1", "pm", "room_mention");
    clearActivationSource("r1", "pm");
    expect(getActivationSource("r1", "pm")).toBeNull();
  });

  it("stale value expires after 30 minutes", () => {
    vi.useFakeTimers();
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(now);

    setActivationSource("r1", "pm", "room_mention");
    vi.advanceTimersByTime(30 * 60_000 + 1);

    expect(getActivationSource("r1", "pm")).toBeNull();
  });

  it("keys are isolated by room+agent", () => {
    setActivationSource("r1", "pm", "room_mention");
    setActivationSource("r1", "qa", "private_instruction");
    setActivationSource("r2", "pm", "system");

    expect(getActivationSource("r1", "pm")).toBe("room_mention");
    expect(getActivationSource("r1", "qa")).toBe("private_instruction");
    expect(getActivationSource("r2", "pm")).toBe("system");
  });
});
