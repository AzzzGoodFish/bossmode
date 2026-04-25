import { useCallback, useRef } from "react";

interface LongPressOpts {
  onLongPress: (e: React.TouchEvent) => void;
  delay?: number;          // ms, default 500
  moveThreshold?: number;  // px, default 8
}

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  consumedClick: () => boolean;
}

export function useLongPress({ onLongPress, delay = 500, moveThreshold = 8 }: LongPressOpts): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    firedRef.current = false;
    const touch = e.touches[0];
    startPosRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      onLongPress(e);
      timerRef.current = null;
    }, delay);
  }, [onLongPress, delay]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!startPosRef.current || !timerRef.current) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startPosRef.current.x;
    const dy = touch.clientY - startPosRef.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > moveThreshold) {
      clear();
    }
  }, [clear, moveThreshold]);

  const onTouchEnd = useCallback(() => {
    clear();
  }, [clear]);

  const consumedClick = useCallback(() => {
    if (firedRef.current) {
      firedRef.current = false;
      return true;
    }
    return false;
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, consumedClick };
}
