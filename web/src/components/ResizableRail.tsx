import { useEffect, useRef, useState, type ReactNode } from "react";

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const STORAGE_KEY = "bossmode.rail.width";

/** Right-rail container with a draggable divider (fish 2026-08-21). The 7px
 * invisible grip sits on the rail's left edge (hover = accent tint); drag left
 * to widen, right to narrow, double-click resets to the default. Width persists
 * in localStorage. Children manage their own scrolling — the root must stay
 * overflow-visible so the grip overhang isn't clipped. */
export function ResizableRail({ children, className = "" }: { children: ReactNode; className?: string }) {
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v >= MIN_WIDTH && v <= MAX_WIDTH ? v : DEFAULT_WIDTH;
  });
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, w: DEFAULT_WIDTH });

  useEffect(() => { localStorage.setItem(STORAGE_KEY, String(width)); }, [width]);
  useEffect(() => {
    if (!dragging) return;
    document.body.style.userSelect = "none";
    return () => { document.body.style.userSelect = ""; };
  }, [dragging]);

  return (
    <div className={`relative border-l border-line shrink-0 ${className}`} style={{ width }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workstations panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={(e) => {
          e.preventDefault();
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
          startRef.current = { x: e.clientX, w: width };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!dragging) return;
          const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(startRef.current.w + (startRef.current.x - e.clientX))));
          setWidth(next);
        }}
        onPointerUp={() => setDragging(false)}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        className={`absolute top-0 bottom-0 -left-[3px] w-[7px] cursor-col-resize z-20 transition-colors ${dragging ? "bg-accent/50" : "hover:bg-accent/30"}`}
      >
        {/* Persistent grip mark — the small visual difference that says "this
         * divider is draggable". It hugs the line's LEFT face (chat side):
         * the handle belongs to the pane you pull (fish 2026-08-21 v3). */}
        <span className={`absolute right-[5px] top-1/2 -translate-y-1/2 w-[3px] h-6 rounded-full transition-colors ${dragging ? "bg-accent" : "bg-ink-4/40"}`} />
      </div>
      {children}
    </div>
  );
}
