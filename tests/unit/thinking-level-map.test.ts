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

  it("empty custom omits map entry (intermediate state) — map must not force mode snap-back", () => {
    // Selecting Custom on xhigh with empty input must not write a key.
    // Parent value stays undefined/default for xhigh → if UI derived modes from value
    // alone, mode would snap back to Not available. Local state holds "custom".
    const modes = allModes("as-is");
    modes.xhigh = "custom";
    modes.max = "off";
    const customs = emptyCustoms();
    expect(buildThinkingLevelMap(modes, customs)).toBeUndefined();

    // After typing, map gains the remap.
    customs.xhigh = "max";
    expect(buildThinkingLevelMap(modes, customs)).toEqual({ xhigh: "max" });

    // Mid-level empty custom also omits (treated as as-is for data).
    modes.xhigh = "off";
    modes.medium = "custom";
    customs.xhigh = "";
    customs.medium = "";
    expect(buildThinkingLevelMap(modes, customs)).toBeUndefined();
  });

  it("simulates local-state editor: empty custom stays selected across parent rewrite", () => {
    // Mirrors ThinkingLevelMapEditor push loop: local modes/customs + emitted map.
    let value: ReturnType<typeof buildThinkingLevelMap>;
    let modes = allModes("as-is");
    modes.xhigh = "off";
    modes.max = "off";
    let customs = emptyCustoms();
    let emitted = JSON.stringify(value ?? null);

    const push = () => {
      const next = buildThinkingLevelMap(modes, customs);
      emitted = JSON.stringify(next ?? null);
      value = next;
      // Parent rewrites value; editor only re-seeds when incoming !== emitted.
      const incoming = JSON.stringify(value ?? null);
      if (incoming !== emitted) {
        // would re-seed from value — must not happen for our own push
        throw new Error("unexpected external reseed");
      }
    };

    // Select Custom on xhigh (empty) — UI mode stays custom, map still default.
    modes = { ...modes, xhigh: "custom" };
    push();
    expect(modes.xhigh).toBe("custom");
    expect(value).toBeUndefined();

    // Type max — map updates, mode still custom.
    customs = { ...customs, xhigh: "max" };
    push();
    expect(modes.xhigh).toBe("custom");
    expect(value).toEqual({ xhigh: "max" });
  });
});
