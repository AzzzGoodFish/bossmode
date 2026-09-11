import { useEffect, useRef, useState } from "react";
import { CircleHelp, RotateCcw, BookOpen, Info } from "lucide-react";

interface HelpMenuProps {
  onReplayTour: () => void;
}

/**
 * Rail Help control — Replay product tour / Documentation / About.
 * Documentation opens Library (in-app knowledge). About is a small popover.
 */
export function HelpMenu({ onReplayTour }: HelpMenuProps) {
  const [open, setOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number }>({ left: 60, bottom: 80 });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node) && !btnRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ left: r.right + 10, bottom: window.innerHeight - r.bottom });
    }
    setOpen((v) => !v);
    setAboutOpen(false);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        title="Help"
        aria-label="Help"
        aria-expanded={open}
        data-tour="help"
        className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
          open ? "bg-surface-2 text-ink-1" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"
        }`}
      >
        <CircleHelp size={18} />
      </button>

      {open && (
        <div
          ref={rootRef}
          className="fixed z-50 w-[220px] bg-surface-1 border border-line rounded-xl overflow-hidden"
          style={{ left: pos.left, bottom: pos.bottom, boxShadow: "var(--shadow-pop, 0 10px 32px rgba(16,24,40,0.18))" }}
          role="menu"
          aria-label="Help menu"
        >
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2.5 w-full text-left px-3.5 py-2.5 text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink-1 cursor-pointer bg-transparent border-0"
            onClick={() => {
              setOpen(false);
              onReplayTour();
            }}
          >
            <RotateCcw size={14} className="shrink-0" />
            Replay product tour
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2.5 w-full text-left px-3.5 py-2.5 text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink-1 cursor-pointer bg-transparent border-0"
            onClick={() => setAboutOpen((v) => !v)}
          >
            <Info size={14} className="shrink-0" />
            About Bossmode
          </button>
          {aboutOpen && (
            <div className="px-3.5 pb-3 pt-0 text-[11.5px] text-ink-3 border-t border-line-soft">
              <div className="font-semibold text-ink-1 mt-2 mb-0.5">Bossmode</div>
              <p>Run work with your member team — roles, chat and shared memory.</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
