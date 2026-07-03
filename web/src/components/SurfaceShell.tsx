import { useEffect, type ReactNode } from "react";

/**
 * SurfaceShell — the shared near-fullscreen surface container (GOO-113 family).
 *
 * One form factor, learned once: slim context bar on top (icon · title · meta ·
 * center slot · actions · close), everything else is content. Used by
 * PreviewSurface (artifacts/attachments) and Room Settings; task preview and
 * docs preview reuse it next. Overlay semantics: Esc closes, chat stays behind.
 */
export function SurfaceShell({
  icon,
  title,
  meta,
  center,
  actions,
  onClose,
  children,
  testid,
}: {
  icon?: ReactNode;
  title: string;
  meta?: ReactNode;
  /** middle slot (e.g. file tabs) — truncates before actions */
  center?: ReactNode;
  /** right-side action buttons, rendered before the close button */
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  testid?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] bg-surface-0 flex flex-col" data-testid={testid}>
      <div className="h-11 shrink-0 border-b border-line bg-surface-1 px-3 flex items-center gap-2">
        {icon}
        <div className="min-w-0 flex items-baseline gap-2">
          <div className="text-sm font-semibold text-ink-1 truncate">{title}</div>
          {meta}
        </div>
        {center}
        <div className="flex-1" />
        {actions}
        <button
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
          className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer shrink-0"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}
