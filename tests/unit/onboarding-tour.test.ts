import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  ONBOARDING_DONE_KEY,
  clearOnboardingDone,
  getOnboardingDone,
  isOnboardingDone,
  markOnboardingDone,
} from "../../web/src/onboarding/storage";
import { TOUR_STEPS, TOUR_STEP_COUNT } from "../../web/src/onboarding/steps";
import { centerBubble, padRect, placeBubble, rectsEqual, waitForStableRect } from "../../web/src/onboarding/geometry";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("onboarding storage", () => {
  const mem = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
  };

  beforeEach(() => {
    mem.clear();
    Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
    clearOnboardingDone();
  });
  afterEach(() => {
    clearOnboardingDone();
    mem.clear();
  });

  it("starts undone and records finished/skipped", () => {
    expect(isOnboardingDone()).toBe(false);
    expect(getOnboardingDone()).toBeNull();

    markOnboardingDone("finished");
    expect(isOnboardingDone()).toBe(true);
    expect(getOnboardingDone()).toBe("finished");
    expect(localStorage.getItem(ONBOARDING_DONE_KEY)).toBe("finished");

    clearOnboardingDone();
    markOnboardingDone("skipped");
    expect(getOnboardingDone()).toBe("skipped");
  });
});

describe("onboarding steps", () => {
  it("covers welcome → model → room → chat → done with anchors", () => {
    expect(TOUR_STEP_COUNT).toBe(5);
    expect(TOUR_STEPS.map((s) => s.key)).toEqual(["welcome", "model", "room", "chat", "done"]);
    expect(TOUR_STEPS.find((s) => s.key === "model")?.target).toBe("connect-provider");
    expect(TOUR_STEPS.find((s) => s.key === "model")?.prepare).toBe("settings-models");
    expect(TOUR_STEPS.find((s) => s.key === "room")?.target).toBe("new-room");
    expect(TOUR_STEPS.find((s) => s.key === "chat")?.target).toBe("composer");
    expect(TOUR_STEPS[0].center).toBe(true);
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].center).toBe(true);
  });

  it("model step explains how + two provider kinds", () => {
    const model = TOUR_STEPS.find((s) => s.key === "model")!;
    expect(model.blocks?.some((b) => b.heading === "How")).toBe(true);
    expect(model.blocks?.some((b) => b.heading === "Two kinds")).toBe(true);
    const kinds = model.blocks!.find((b) => b.heading === "Two kinds")!.lines.join(" ");
    expect(kinds).toMatch(/Built-in/i);
    expect(kinds).toMatch(/Custom endpoint/i);
  });
});

describe("onboarding geometry", () => {
  it("pads spotlight rect and clamps bubble into viewport", () => {
    const base = { left: 100, top: 100, width: 40, height: 40, right: 140, bottom: 140 };
    const padded = padRect(base, 6);
    expect(padded.left).toBe(94);
    expect(padded.width).toBe(52);

    const right = placeBubble(base, "right", 320, 200, 800, 600);
    expect(right.left).toBeGreaterThanOrEqual(12);
    expect(right.left + 320).toBeLessThanOrEqual(800 - 12);

    const top = placeBubble(base, "top", 320, 200, 400, 300);
    expect(top.top).toBeGreaterThanOrEqual(12);

    const center = centerBubble(320, 200, 1000, 800);
    expect(center.left).toBe(340);
    expect(center.top).toBe(300);
  });

  it("rectsEqual tolerates sub-pixel noise",
    () => {
      const a = { left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60 };
      const b = { ...a, left: 10.3, top: 20.2 };
      expect(rectsEqual(a, b)).toBe(true);
      expect(rectsEqual(a, { ...a, top: 30 })).toBe(false);
    },
  );

  it("waitForStableRect resolves after consecutive matching samples",
    async () => {
      let n = 0;
      const rect = { left: 1, top: 2, width: 3, height: 4, right: 4, bottom: 6 };
      const got = await waitForStableRect(
        () => {
          n += 1;
          // first sample drifts, then settles
          if (n === 1) return { ...rect, top: 8 };
          return rect;
        },
        { stableFrames: 2, maxWaitMs: 500, intervalMs: 5 },
      );
      expect(got).toEqual(rect);
      expect(n).toBeGreaterThanOrEqual(3);
    },
  );
});

describe("onboarding product anchors (source)", () => {
  it("wires data-tour anchors and Help/tour entry points", () => {
    const sidebar = source("web/src/components/Sidebar.tsx");
    expect(sidebar).toContain('data-tour="new-room"');
    expect(sidebar).toContain('data-tour="settings"');
    expect(sidebar).toContain("HelpMenu");
    expect(sidebar).toContain("onReplayTour");

    const settings = source("web/src/pages/SettingsPage.tsx");
    expect(settings).toContain('data-tour="connect-provider"');

    const input = source("web/src/components/MessageInput.tsx");
    expect(input).toContain('data-tour="composer"');

    const layout = source("web/src/pages/Layout.tsx");
    expect(layout).toContain("OnboardingTour");
    expect(layout).toContain("isOnboardingDone");
    expect(layout).toContain("onReplayTour");

    const help = source("web/src/components/HelpMenu.tsx");
    expect(help).toContain("Replay product tour");
    expect(help).toContain("Documentation");
    expect(help).toContain("About Bossmode");

    const tour = source("web/src/components/OnboardingTour.tsx");
    expect(tour).toContain("waitForStableRect");
    expect(tour).toContain("ResizeObserver");
    expect(tour).toContain("remeasureTarget");
  });
});
