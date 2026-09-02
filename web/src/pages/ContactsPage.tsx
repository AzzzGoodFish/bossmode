/**
 * ContactsPage — member directory (0.20 member-global model).
 *
 * Every member is a globally unique digital employee: one identity, many scopes
 * (DM + rooms). Row shows live status, effective model, context usage and
 * lifetime tokens. Click a row to open the DM. Data: GET /api/contacts.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Search, MessageSquare } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { createGlobalMember, getContacts, getRooms, type ContactEntry, type Room } from "../api/client";

type StatusFilter = "all" | "working" | "idle" | "error";

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}

function scopeLabel(scopeId: string, roomNames: Map<string, string>): string {
  if (scopeId.startsWith("dm:")) return "DM";
  const roomId = scopeId.replace(/^room:/, "");
  return roomNames.get(roomId) ?? "room";
}

export function ContactsPage({ onOpenDm, onOpenImport }: {
  onOpenDm: (memberId: string) => void;
  onOpenImport?: () => void;
}) {
  const [contacts, setContacts] = useState<ContactEntry[] | null>(null);
  const [roomNames, setRoomNames] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // One-click hire (fish 2026-08-25, batch-1 identity rework): zero form — send
  // no name and the backend assigns "New Member N" (auto-increment); the new
  // member wakes up in its DM where the guidance card guides the rest.
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createMember = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createGlobalMember({});
      onOpenDm(res.member.memberId);
    } catch (e) {
      setCreateError(String((e as Error)?.message || e));
      setCreating(false);
    }
  };
  const [filter, setFilter] = useState<StatusFilter>("all");

  useEffect(() => {
    let cancelled = false;
    getContacts()
      .then((res) => { if (!cancelled) setContacts(res.contacts); })
      .catch((err) => { if (!cancelled) setError(String(err?.message || err)); });
    getRooms()
      .then((rooms: Room[]) => { if (!cancelled) setRoomNames(new Map(rooms.map((r) => [r.id, r.name]))); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const members = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (contacts ?? []).filter((m) => {
      if (filter !== "all" && m.status !== filter) return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || m.agentTemplate.toLowerCase().includes(q);
    });
  }, [contacts, query, filter]);

  const workingCount = (contacts ?? []).filter((m) => m.status === "working").length;

  return (
    <div className="flex-1 overflow-y-auto bg-surface-1">
      <div className="w-full px-6 md:px-10 pt-7 pb-16">
        {/* header */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <h1 className="text-[19px] font-bold tracking-tight text-ink-1">Contacts</h1>
            <p className="text-[12.5px] text-ink-3 mt-1">
              Your digital employees — one identity, every scope.
              {contacts && ` ${contacts.length} members · ${workingCount} working now.`}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {onOpenImport && (
              <button
                type="button"
                onClick={onOpenImport}
                className="text-[12px] text-ink-4 hover:text-ink-2 cursor-pointer transition-colors"
              >
                Import
              </button>
            )}
            <button
              type="button"
              onClick={() => void createMember()}
              disabled={creating}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent text-accent-contrast text-sm font-medium rounded-lg hover:opacity-90 cursor-pointer shrink-0 disabled:opacity-60"
            >
              {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} New member
            </button>
          </div>
        </div>
        {createError && <div role="alert" className="text-[12px] text-blocked mb-3">Couldn't create the member. {createError}</div>}

        {/* search + filter */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members…"
              className="w-64 rounded-lg border border-line bg-inset pl-8 pr-3 py-1.5 text-[12.5px] text-ink-1 outline-none focus:border-accent placeholder:text-ink-4"
            />
          </div>
          <div className="flex items-center gap-1.5">
            {(["all", "working", "idle", "error"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`text-xs px-2.5 py-1 rounded-md border transition-colors cursor-pointer ${
                  filter === f ? "bg-accent border-accent text-accent-contrast" : "border-line text-ink-3 hover:text-ink-1"
                }`}
              >
                {f === "all" ? "All" : f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* member list */}
        {error ? (
          <div role="alert" className="rounded-xl border border-blocked/30 bg-blocked-dim/25 px-4 py-3 text-xs text-blocked">
            Couldn’t load contacts. {error}
          </div>
        ) : !contacts ? (
          <div className="py-14 text-center text-sm text-ink-3">Loading…</div>
        ) : (
          <div className="rounded-xl border border-line bg-inset/50 overflow-hidden">
            {members.length === 0 ? (
              <div className="py-14 text-center text-sm text-ink-3">
                {contacts.length === 0 ? "No members yet — create your first digital employee." : "No members match."}
              </div>
            ) : (
              members.map((m, i) => (
                <MemberRow key={m.memberId} member={m} roomNames={roomNames} last={i === members.length - 1} onOpen={() => onOpenDm(m.memberId)} />
              ))
            )}
          </div>
        )}

        <p className="text-[11px] text-ink-4 mt-3">
          Members are global — the same identity works in DM and every room, with shared four-layer memory.
        </p>
      </div>
    </div>
  );
}

function MemberRow({ member: m, roomNames, last, onOpen }: { member: ContactEntry; roomNames: Map<string, string>; last: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group w-full flex items-center gap-4 px-4 py-3.5 text-left bg-surface-1 hover:bg-surface-2 transition-colors cursor-pointer ${last ? "" : "border-b border-line-soft"}`}
    >
      <StaffBadge name={m.name} status={statusFromAgent(m.status)} size="md" />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] font-semibold text-ink-1">{m.name}</span>
          {m.title ? <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{m.title}</span> : null}
        </div>
        <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
          {m.status === "working" ? (
            <span className="text-onair font-medium">● Working</span>
          ) : m.status === "error" ? (
            <span className="text-blocked font-medium">● Error</span>
          ) : (
            <span className="text-ink-4">Idle</span>
          )}
          <span className="text-ink-4 truncate">
            {m.activeScopes.map((s) => scopeLabel(s, roomNames)).join(" · ")}
          </span>
        </div>
      </div>

      <div className="hidden md:flex items-center gap-6 shrink-0 text-right">
        <Meta label="Model" value={m.model ?? "—"} mono />
        <Meta label="Context" value={m.contextPct != null ? `${m.contextPct}%` : "—"} warn={(m.contextPct ?? 0) >= 80} />
        <Meta label="Tokens" value={formatTokenCount(m.tokensTotal)} mono title={`${formatTokenCount(m.tokensToday)} today`} />
        <Meta label="Scopes" value={String(m.activeScopes.length)} />
      </div>

      <span title="Message" className="w-7 h-7 rounded-lg border border-line text-ink-3 group-hover:text-accent-ink group-hover:border-accent flex items-center justify-center shrink-0 transition-colors">
        <MessageSquare size={14} />
      </span>
    </button>
  );
}

function Meta({ label, value, mono, warn, title }: { label: string; value: string; mono?: boolean; warn?: boolean; title?: string }) {
  return (
    <div className="min-w-[64px]" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-ink-4">{label}</div>
      <div className={`text-[12.5px] mt-0.5 ${mono ? "tabular-nums font-medium" : "font-medium"} ${warn ? "text-blocked" : "text-ink-2"}`}>{value}</div>
    </div>
  );
}
