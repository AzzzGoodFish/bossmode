import { useEffect, useRef } from "react";
import { useIsMobile } from "../hooks/useIsMobile";

const SIZE_CLS: Record<string, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

interface SheetProps {
  open: boolean;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  closeOnOverlayClick?: boolean;
  children: React.ReactNode;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.closest("[disabled]") && getComputedStyle(el).display !== "none");
}

export function Sheet({ open, onClose, size = "md", closeOnOverlayClick = true, children }: SheetProps) {
  const isMobile = useIsMobile();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Body scroll lock + focus management
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.body.classList.add("overflow-hidden");
      const t = setTimeout(() => {
        if (panelRef.current) {
          const items = getFocusable(panelRef.current);
          items[0]?.focus();
        }
      }, 300);
      return () => clearTimeout(t);
    } else {
      document.body.classList.remove("overflow-hidden");
      previousFocusRef.current?.focus();
    }
  }, [open]);

  // Escape + focus trap
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = getFocusable(panel);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Overlay click guard: only close when mousedown AND mouseup both on overlay itself
  // (prevents accidental close when user drags-to-select inside panel and releases on overlay)
  const overlayMouseDownRef = useRef(false);
  const handleOverlayMouseDown = (e: React.MouseEvent) => {
    overlayMouseDownRef.current = e.target === e.currentTarget;
  };
  const handleOverlayMouseUp = (e: React.MouseEvent) => {
    const wasOverlay = overlayMouseDownRef.current && e.target === e.currentTarget;
    overlayMouseDownRef.current = false;
    if (closeOnOverlayClick && wasOverlay) onClose();
  };

  // Swipe-to-dismiss (mobile only)
  const swipeStartY = useRef<number | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    swipeStartY.current = e.touches[0].clientY;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (swipeStartY.current === null) return;
    const dy = e.changedTouches[0].clientY - swipeStartY.current;
    if (dy > 60) onClose();
    swipeStartY.current = null;
  };

  if (!open) return null;

  if (!isMobile) {
    // Desktop: centered modal
    return (
      <div
        className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
        onMouseDown={handleOverlayMouseDown}
        onMouseUp={handleOverlayMouseUp}
      >
        <div
          ref={panelRef}
          aria-modal="true"
          role="dialog"
          className={`w-full ${SIZE_CLS[size]} bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-xl max-h-[80vh] overflow-y-auto`}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    );
  }

  // Mobile: bottom sheet
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50"
        onMouseDown={handleOverlayMouseDown}
        onMouseUp={handleOverlayMouseUp}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        aria-modal="true"
        role="dialog"
        className="relative w-full rounded-t-2xl bg-white dark:bg-zinc-900 shadow-xl max-h-[90vh] overflow-y-auto overscroll-contain
                   animate-sheet-up pb-[env(safe-area-inset-bottom)]"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>
        {children}
      </div>
    </div>
  );
}
