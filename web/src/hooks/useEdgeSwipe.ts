import { useEffect } from "react";
import { useIsMobile } from "./useIsMobile";

interface EdgeSwipeOpts {
  side: "left" | "right";
  edgeWidth?: number;    // px from edge, default 16
  threshold?: number;    // min swipe distance, default 60
  onTrigger: () => void;
}

export function useEdgeSwipe({ side, edgeWidth = 16, threshold = 60, onTrigger }: EdgeSwipeOpts): void {
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!isMobile) return;

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      const w = window.innerWidth;
      tracking = side === "left"
        ? startX <= edgeWidth
        : startX >= w - edgeWidth;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const horizontal = side === "left" ? dx : -dx;
      if (horizontal >= threshold && Math.abs(dy) < Math.abs(dx)) {
        onTrigger();
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, side, edgeWidth, threshold, onTrigger]);
}
