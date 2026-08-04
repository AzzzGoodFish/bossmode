import { ArrowLeft } from "lucide-react";

/**
 * Shared back control for detail pages.
 * Always renders as its own block (own row) — do not nest inside title/action flex rows.
 * Visual baseline: Skills (ArrowLeft 18, ink-4 → hover ink-1, ≥32px hit target).
 */
export function BackLink({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="mb-4 shrink-0">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 min-h-8 py-1 text-xs font-medium text-ink-4 hover:text-ink-1 transition-colors cursor-pointer"
      >
        <ArrowLeft size={18} strokeWidth={2} aria-hidden />
        <span>{label}</span>
      </button>
    </div>
  );
}
