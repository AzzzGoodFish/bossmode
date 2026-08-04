/**
 * ResourceList — shared list-page skeleton + row for resource domains
 * (Templates / Skills; Library keeps its tree but aligns metrics).
 * Chat & List Unification v1: one resource-list language, existing Tailwind
 * values only, no new tokens.
 */
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function ResourceListPage({ title, subtitle, action, search, children }: {
  title: string;
  /** Domain description including the item count. */
  subtitle: string;
  /** Top-right primary action (e.g. "New template"). Omit when the domain has no create. */
  action?: ReactNode;
  /** Search input row (already wired). */
  search?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full px-6 md:px-10 pt-7 pb-16">
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <h1 className="text-[19px] font-bold tracking-tight text-ink-1">{title}</h1>
          {action}
        </div>
        <p className="text-[12.5px] text-ink-3 mb-5">{subtitle}</p>
        {search}
        {children}
      </div>
    </div>
  );
}

export function ResourceListContainer({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-line divide-y divide-line-soft">{children}</div>;
}

export function ResourceRow({ icon, name, badges, description, meta, metaTitle, onClick }: {
  /** Leading 32px icon block content (domain icon). */
  icon: ReactNode;
  name: string;
  /** Inline pills following the name (e.g. built-in badge, tags). */
  badges?: ReactNode;
  description?: string;
  /** Right-aligned meta line (e.g. "used by 3"). */
  meta?: string;
  metaTitle?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-3 hover:bg-surface-2 transition-colors cursor-pointer flex items-center gap-3"
    >
      <span className="shrink-0 w-8 h-8 rounded-lg bg-surface-2 border border-line-soft flex items-center justify-center text-ink-3">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] font-semibold text-ink-1">{name}</span>
          {badges}
        </div>
        {description !== undefined && (
          <div className="text-[11.5px] text-ink-3 mt-0.5 truncate">{description || "No description"}</div>
        )}
      </div>
      {meta && <span className="shrink-0 text-[11px] text-ink-4" title={metaTitle}>{meta}</span>}
      <ChevronRight size={14} className="shrink-0 text-ink-4" />
    </button>
  );
}
