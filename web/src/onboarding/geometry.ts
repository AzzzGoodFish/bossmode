/** Pure geometry helpers for spotlight + bubble placement (unit-testable). */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export function padRect(r: RectLike, pad: number): RectLike {
  return {
    left: r.left - pad,
    top: r.top - pad,
    width: r.width + pad * 2,
    height: r.height + pad * 2,
    right: r.right + pad,
    bottom: r.bottom + pad,
  };
}

export function placeBubble(
  target: RectLike,
  place: "right" | "top" | "bottom",
  bubbleW: number,
  bubbleH: number,
  viewportW: number,
  viewportH: number,
  gap = 14,
): { left: number; top: number } {
  let left: number;
  let top: number;
  if (place === "right") {
    left = target.right + gap;
    top = target.top + target.height / 2 - bubbleH / 2;
  } else if (place === "top") {
    left = target.left + target.width / 2 - bubbleW / 2;
    top = target.top - bubbleH - gap;
  } else {
    left = target.left + target.width / 2 - bubbleW / 2;
    top = target.bottom + gap;
  }
  left = Math.max(12, Math.min(left, viewportW - bubbleW - 12));
  top = Math.max(12, Math.min(top, viewportH - bubbleH - 12));
  return { left, top };
}

export function centerBubble(
  bubbleW: number,
  bubbleH: number,
  viewportW: number,
  viewportH: number,
): { left: number; top: number } {
  return {
    left: Math.max(12, viewportW / 2 - bubbleW / 2),
    top: Math.max(12, viewportH / 2 - bubbleH / 2),
  };
}

/** Pixel tolerance for "same" rect — sub-pixel layout noise. */
export function rectsEqual(a: RectLike | null, b: RectLike | null, eps = 0.5): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.left - b.left) <= eps &&
    Math.abs(a.top - b.top) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

/**
 * Poll element rect until N consecutive samples match (layout settled),
 * or until maxWaitMs elapses. Returns the last measured rect.
 */
export async function waitForStableRect(
  measure: () => RectLike | null,
  opts: { stableFrames?: number; maxWaitMs?: number; intervalMs?: number } = {},
): Promise<RectLike | null> {
  const stableFrames = opts.stableFrames ?? 2;
  const maxWaitMs = opts.maxWaitMs ?? 800;
  const intervalMs = opts.intervalMs ?? 32;
  const start = Date.now();
  let last: RectLike | null = null;
  let streak = 0;

  while (Date.now() - start < maxWaitMs) {
    const cur = measure();
    if (cur && rectsEqual(cur, last)) {
      streak += 1;
      if (streak >= stableFrames) return cur;
    } else {
      last = cur;
      streak = cur ? 1 : 0;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return measure() ?? last;
}
