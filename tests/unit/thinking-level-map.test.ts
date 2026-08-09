import { describe, expect, it } from "vitest";
import {
  THINKING_LEVEL_KEYS,
  buildThinkingLevelMap,
  levelModeFromMap,
  summarizeThinkingMap,
  type LevelMode,
  type ThinkingLevelKey,
} from "../../web/src/components/ThinkingLevelMapEditor";

function allModes(fill: LevelMode): Record<ThinkingLevelKey, LevelMode> {
  const m = {} as Record<ThinkingLevelKey, LevelMode>;
  for (const k of THINKING_LEVEL_KEYS) m[k] = fill;
  return m;
}

function emptyCustoms(): Record<ThinkingLevelKey, string> {
  const m = {} as Record<ThinkingLevelKey, string>;
  for (const k of THINKING_LEVEL_KEYS) m[k] = "";
  return m;
}

describe("thinking level map builder", () => {
  it("omits map entirely when fully default (off–high as-is, xhigh/max off)", () => {
    const modes = allModes("as-is");
    modes.xhigh = "off";
    modes.max = "off";
    expect(buildThinkingLevelMap(modes, emptyCustoms())).toBeUndefined();
  });

  it("unlocks xhigh/max with passthrough name on as-is", () => {
    const modes = allModes("as-is");
    modes.xhigh = "as-is";
    modes.max = "off";
    expect(buildThinkingLevelMap(modes, emptyCustoms())).toEqual({ xhigh: "xhigh" });
  });

  it("writes custom remap and null disable for mid levels", () => {
    const modes = allModes("as-is");
    modes.xhigh = "off";
    modes.max = "off";
    modes.high = "custom";
    modes.minimal = "off";
    const customs = emptyCustoms();
    customs.high = "elevated";
    expect(buildThinkingLevelMap(modes, customs)).toEqual({
      high: "elevated",
      minimal: null,
    });
  });

  it("round-trips mode detection", () => {
    const map = { high: "elevated", minimal: null, xhigh: "xhigh", max: "max" } as const;
    expect(levelModeFromMap(map, "off")).toBe("as-is");
    expect(levelModeFromMap(map, "minimal")).toBe("off");
    expect(levelModeFromMap(map, "high")).toBe("custom");
    expect(levelModeFromMap(map, "xhigh")).toBe("as-is");
    expect(levelModeFromMap(undefined, "xhigh")).toBe("off");
    expect(levelModeFromMap(undefined, "medium")).toBe("as-is");
  });

  it("summarizes default and dirty maps", () => {
    expect(summarizeThinkingMap(undefined)).toContain("off–high as-is");
    expect(summarizeThinkingMap({ xhigh: "max", minimal: null })).toMatch(/remapped|off/);
  });
});
