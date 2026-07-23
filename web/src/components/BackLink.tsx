import { ArrowLeft } from "lucide-react";

/** Shared back control for Team / Agent / Skill detail pages. */
export function BackLink({
  label,
  onClick,
  className = "",
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`mb-4 inline-flex items-center gap-1.5 min-h-7 text-xs font-medium text-ink-4 hover:text-ink-1 transition-colors cursor-pointer ${className}`}
    >
      <ArrowLeft size={16} strokeWidth={2} aria-hidden />
      <span>{label}</span>
    </button>
  );
}
