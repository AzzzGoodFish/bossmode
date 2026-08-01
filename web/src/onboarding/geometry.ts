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
