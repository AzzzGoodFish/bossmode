import { describe, expect, it } from "vitest";
import { clampPreviewPct, formatPreviewPct, PREVIEW_LEGACY_WIDTH_STORAGE_KEY, PREVIEW_PCT_STORAGE_KEY, readPreviewPct } from "../../web/src/utils/preview-pane-sizing";

function storage(values: Record<string, string | null>) {
  return {
    getItem(key: string) {
      return values[key] ?? null;
    },
  };
}

describe("preview pane percentage sizing", () => {
  it("clamps preview split to the 25–75% range", () => {
    expect(clampPreviewPct(10)).toBe(25);
    expect(clampPreviewPct(50)).toBe(50);
    expect(clampPreviewPct(90)).toBe(75);
  });

  it("reads persisted percentage and rounds storage formatting", () => {
    expect(readPreviewPct(storage({ [PREVIEW_PCT_STORAGE_KEY]: "74.77" }), 1440)).toBe(74.77);
    expect(formatPreviewPct(74.77)).toBe("74.8");
  });

  it("migrates legacy pixel width against viewport width", () => {
    expect(readPreviewPct(storage({ [PREVIEW_LEGACY_WIDTH_STORAGE_KEY]: "760" }), 2560)).toBeCloseTo(29.6875);
    expect(readPreviewPct(storage({ [PREVIEW_LEGACY_WIDTH_STORAGE_KEY]: "2000" }), 2560)).toBe(75);
  });

  it("uses default when no valid preference exists", () => {
    expect(readPreviewPct(storage({}), 1440)).toBe(32);
    expect(readPreviewPct(storage({ [PREVIEW_PCT_STORAGE_KEY]: "bad", [PREVIEW_LEGACY_WIDTH_STORAGE_KEY]: "bad" }), 1440)).toBe(32);
  });
});
