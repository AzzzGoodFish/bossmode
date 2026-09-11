import { useEffect, useRef } from "react";

interface MobileDrawerProps {
  open: boolean;
  side: "left" | "right";
  onClose: () => void;
  width?: string; // Tailwind width class, default "w-72"
  children: React.ReactNode;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (el) =>
      !el.closest("[disabled],[inert]") &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden",
  );
}

export function MobileDrawer({
  open,
  side,
  onClose,
  width = "w-72",
  children,
}: MobileDrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Body scroll lock
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      document.body.classList.add("overflow-hidden");
      // Focus first focusable inside drawer
      const frame = window.requestAnimationFrame(() => {
        const drawer = drawerRef.current;
        if (
          drawer &&
          !drawer.contains(document.activeElement) &&
          !document.querySelector(".bm-popover,[data-member-float]")
        ) {
          getFocusable(drawer)[0]?.focus({ preventScroll: true });
        }
      });
      return () => {
        window.cancelAnimationFrame(frame);
        document.body.classList.remove("overflow-hidden");
      };
    } else {
      document.body.classList.remove("overflow-hidden");
      previousFocusRef.current?.focus();
    }
  }, [open]);

  // Escape + focus trap
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector(".bm-popover,[data-member-float]")) return;
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const drawer = drawerRef.current;
      if (!drawer) return;
      const items = getFocusable(drawer);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const translateOut =
    side === "left" ? "-translate-x-full" : "translate-x-full";
  const positionCls = side === "left" ? "left-0" : "right-0";

  return (
    <div
      aria-modal={open ? true : undefined}
      role={open ? "dialog" : undefined}
      aria-hidden={!open || undefined}
      inert={!open}
      data-mobile-drawer
      className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
    >
      {/* Overlay */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
      />
      {/* Drawer panel */}
      <div
        ref={drawerRef}
        className={`absolute inset-y-0 ${positionCls} ${width} max-w-[85vw] flex flex-col
          bg-surface-0 shadow-xl
          transform transition-transform duration-300 ease-out
          ${open ? "translate-x-0" : translateOut}
          overflow-y-auto overscroll-contain
          pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`}
      >
        {children}
      </div>
    </div>
  );
}
