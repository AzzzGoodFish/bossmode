import { useMemberProfileRevision } from "../hooks/useMemberProfileRevision";
import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  LogOut, MessageSquare, Settings, Sun, Moon,
  Loader2, Plus, Contact, Hash, Search,
  
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Room } from "../api/client";
import { createGlobalMember, getRooms, getChats, type ChatEntry } from "../api/client";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { HelpMenu } from "./HelpMenu";

export type SettingsSection = "models" | "usage";

export type ActivePage =
  | { type: "chats" }
  | { type: "dm"; memberId: string }
  | { type: "room"; id: string }
  | { type: "settings"; section?: SettingsSection }
  | null;

type Domain = "chats" | "system";

export function domainOf(page: ActivePage): Domain {
  switch (page?.type) {
    case "chats":
      return "chats";
    case "dm":
      return "chats";
    case "settings":
      return "system";
    default:
      return "chats";
  }
}

interface SidebarProps {
  activePage: ActivePage;
  username: string;
  onNavigate: (page: ActivePage) => void;
  onLogout: () => void;
  refreshKey?: number;
  unreadRoomIds?: Set<string>;
  onRoomsLoaded?: (rooms: Room[]) => void;
  liveRooms?: Room[];
  collapsed: boolean;
  onToggle: () => void;
  /** Start / replay the product onboarding tour (Help menu). */
  onReplayTour?: () => void;
}

const SYSTEM_SECTIONS: Array<{ id: SettingsSection; title: string; desc: string }> = [
  { id: "models", title: "Models", desc: "Connect providers and choose available models." },
  { id: "usage", title: "Usage", desc: "Token consumption by identity, room and time" },
];



export function Sidebar({
  activePage, username, onNavigate, onLogout, refreshKey,
  unreadRoomIds, onRoomsLoaded, liveRooms, collapsed, onToggle,
  onReplayTour,
}: SidebarProps) {
  const isMobile = useIsMobile();
  const [rooms, setRooms] = useState<Room[]>([]);
  // Chats "+" menu (fish 2026-08-25): New room keeps the original flow; New
  // member runs the batch-1 one-click birth (backend names it) and lands in
  // the DM where the guidance card picks a model.
  const [plusMenu, setPlusMenu] = useState<DOMRect | null>(null);
  const [plusBusy, setPlusBusy] = useState(false);
  const [plusError, setPlusError] = useState<string | null>(null);
  const createMemberFromPlus = async () => {
    setPlusBusy(true);
    setPlusError(null);
    try {
      const res = await createGlobalMember({});
      setPlusMenu(null);
      onNavigate({ type: "dm", memberId: res.member.memberId });
    } catch (e) {
      setPlusError(String((e as Error)?.message || e));
      setPlusBusy(false);
    }
  };
  // Derive the active domain from the page while allowing rail-only browsing.
  const pageDomain = domainOf(activePage);
  const [browseDomain, setBrowseDomain] = useState<Domain | null>(null);
  const domain: Domain = browseDomain ?? pageDomain;
  useEffect(() => { setBrowseDomain(null); }, [activePage]);

  const refresh = () => {
    getRooms().then(setRooms).catch(console.error);
  };

  useEffect(() => { refresh(); }, [refreshKey]);

  useEffect(() => {
    (window as any).__bossmode_rooms = rooms;
    (window as any).__bossmode_refreshSidebar = refresh;
    onRoomsLoaded?.(rooms);
  }, [rooms, onRoomsLoaded]);


  const activeSettingsSection = activePage?.type === "settings" ? (activePage.section ?? "models") : null;

  const hasAnyUnreadRoom = (unreadRoomIds?.size || 0) > 0;

  const toggleTheme = () => {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("bossmode_theme", isDark ? "dark" : "light");
  };

  /* ── Rail ── */
  const railBtn = (active: boolean) =>
    `relative w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
      active ? "bg-surface-2 text-ink-1" : "text-ink-3 hover:bg-surface-2 hover:text-ink-2"
    }`;

  const rail = (
    <nav className="w-[52px] shrink-0 bg-surface-0 border-r border-line-soft flex flex-col items-center py-2.5 gap-1">
      <button
        onClick={onToggle}
        title={collapsed ? "Expand panel" : "Collapse panel"}
        className="w-[30px] h-[30px] rounded-lg bg-accent-dim text-accent-ink flex items-center justify-center font-bold text-sm mb-2 cursor-pointer"
      >
        B
      </button>
      <button onClick={() => { setBrowseDomain("chats"); onNavigate({ type: "chats" }); }} title="Chats" aria-label="Chats" className={railBtn(domain === "chats")}>
        {domain === "chats" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <MessageSquare size={18} />
        {hasAnyUnreadRoom && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-accent" />}
      </button>
      <div className="flex-1" />
      <div className="w-5 h-px bg-line-soft my-1.5" />
      <div className="w-5 h-px bg-line-soft my-1.5" />
      <button onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme" className={railBtn(false)}>
        <Sun size={16} className="hidden dark:block" />
        <Moon size={16} className="block dark:hidden" />
      </button>
      {onReplayTour && (
        <HelpMenu
          onReplayTour={onReplayTour}
        />
      )}
      <button
        onClick={() => { setBrowseDomain("system"); onNavigate({ type: "settings" }); }}
        title="Settings"
        aria-label="Settings"
        data-tour="settings"
        className={railBtn(domain === "system")}
      >
        {domain === "system" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <Settings size={18} />
      </button>
      <button onClick={onLogout} title="Sign out" aria-label="Sign out" className={railBtn(false)}>
        <LogOut size={15} />
      </button>
      <div
        className="w-7 h-7 rounded-full bg-surface-3 flex items-center justify-center text-[11px] text-ink-2 mt-1 select-none"
        title={username}
      >
        {username.charAt(0).toUpperCase()}
      </div>
    </nav>
  );

  /* ── Context panel ── */
  const panelTitle = { chats: "Chats", system: "Settings" }[domain];

  const itemCls = (active: boolean) =>
    `w-full text-left rounded-lg px-2.5 py-2 mb-px transition-colors cursor-pointer ${
      active ? "bg-accent-dim" : "hover:bg-surface-1"
    }`;

  // 24px leading block for panel rows (Chats keeps avatar/hash).
  const leadBlock = (icon: React.ReactNode) => (
    <span className="w-6 h-6 rounded-md bg-surface-2 border border-line-soft text-ink-3 flex items-center justify-center shrink-0">{icon}</span>
  );

  const createBtn = "w-6 h-6 border border-line rounded-md text-ink-3 hover:text-accent-ink hover:border-line-strong flex items-center justify-center cursor-pointer transition-colors";

  const panel = (
    <aside className="w-[236px] shrink-0 bg-surface-0 border-r border-line flex flex-col min-h-0">
      <div className="h-12 shrink-0 flex items-center justify-between px-3.5 border-b border-line-soft">
        <h1 className="text-[13px] font-semibold text-ink-1">{panelTitle}</h1>
        {/* Create entry lives in the panel title row for every domain that has one
            (Chat & List Unification v1); Skills has no create by design. */}
        {domain === "chats" && (
          <>
            <button
              onClick={(e) => setPlusMenu(plusMenu ? null : e.currentTarget.getBoundingClientRect())}
              title="New…"
              data-tour="new-room"
              className={createBtn}
            >
              <Plus size={13} />
            </button>
            {plusMenu && (
              <ChatsPlusMenu
                anchorRect={plusMenu}
                busy={plusBusy}
                error={plusError}
                onNewRoom={() => { setPlusMenu(null); onNavigate({ type: "room", id: "__new__" }); }}
                onNewMember={() => void createMemberFromPlus()}
                onClose={() => { setPlusMenu(null); setPlusError(null); }}
              />
            )}
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {domain === "chats" && <ChatsPanelList activePage={activePage} onNavigate={onNavigate} />}

        {domain === "system" && (
          <>
            {SYSTEM_SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => onNavigate({ type: "settings", section: s.id })}
                className={itemCls(activeSettingsSection === s.id)}
              >
                <div className={`text-[12.5px] font-medium ${activeSettingsSection === s.id ? "text-ink-1" : "text-ink-2"}`}>{s.title}</div>
                <div className="text-[10.5px] text-ink-4 mt-px">{s.desc}</div>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );

  return (
    <div className="flex h-full min-h-0">
      {rail}
      {(!collapsed || isMobile) && panel}

    </div>
  );
}

function SectionHead({ label, onLabelClick, active }: {
  label: string;
  /** Click section label to open the domain page. */
  onLabelClick?: () => void;
  active?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5">
      {onLabelClick ? (
        <button
          type="button"
          onClick={onLabelClick}
          className={`text-[10.5px] font-semibold tracking-[0.05em] cursor-pointer transition-colors text-left ${active ? "text-ink-1" : "text-ink-4 hover:text-ink-2"}`}
          title={`Open ${label.split("·")[0].trim().toLowerCase()} gallery`}
        >
          {label}
        </button>
      ) : (
        <span className="text-[10.5px] font-semibold tracking-[0.05em] text-ink-4">{label}</span>
      )}
    </div>
  );
}

/** Compact unified conversation list for the Chats panel domain. */
function ChatsPanelList({ activePage, onNavigate }: { activePage: ActivePage; onNavigate: (p: ActivePage) => void }) {
  const profileRevision = useMemberProfileRevision();
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = () => getChats().then((r) => { if (!cancelled) setChats(r.chats); }).catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [profileRevision]);
  const sorted = useMemo(
    () => [...(chats ?? [])].sort((a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0)),
    [chats],
  );
  const q = query.trim().toLowerCase();
  const filtered = q ? sorted.filter((c) => c.title.toLowerCase().includes(q)) : sorted;
  const unread = filtered.filter((c) => c.unreadCount > 0 || c.mentioned);
  const rest = filtered.filter((c) => !(c.unreadCount > 0 || c.mentioned));

  if (!chats) return <div className="px-2 py-3 text-[11.5px] text-ink-4">Loading…</div>;
  return (
    <>
      {/* search */}
      <div className="px-1.5 pb-2">
        <div className="flex items-center gap-1.5 rounded-lg border border-line bg-inset px-2.5 py-1.5 focus-within:border-accent transition-colors">
          <Search size={12} className="text-ink-4 shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="w-full bg-transparent outline-none text-[12px] text-ink-1 placeholder:text-ink-4"
          />
        </div>
      </div>

      {sorted.length === 0 && <div className="px-2 py-3 text-[11.5px] text-ink-4">No conversations yet.</div>}
      {sorted.length > 0 && filtered.length === 0 && (
        <div className="px-2 py-3 text-[11.5px] text-ink-4">No matches for “{query.trim()}”.</div>
      )}

      {unread.length > 0 && (
        <>
          <div className="px-2.5 pt-1 pb-1 text-[10.5px] font-semibold tracking-[0.05em] text-ink-4">UNREAD · {unread.length}</div>
          {unread.map((c) => <ChatRow key={c.scopeId} c={c} activePage={activePage} onNavigate={onNavigate} />)}
          <div className="h-2.5" />
        </>
      )}
      {rest.length > 0 && (
        <>
          <div className="px-2.5 pt-1 pb-1 text-[10.5px] font-semibold tracking-[0.05em] text-ink-4">CHATS</div>
          {rest.map((c) => <ChatRow key={c.scopeId} c={c} activePage={activePage} onNavigate={onNavigate} />)}
        </>
      )}
    </>
  );
}

function ChatRow({ c, activePage, onNavigate }: { c: ChatEntry; activePage: ActivePage; onNavigate: (p: ActivePage) => void }) {
  const active =
    (c.kind === "dm" && activePage?.type === "dm" && activePage.memberId === c.memberId) ||
    (c.kind === "room" && activePage?.type === "room" && activePage.id === c.roomId);
  return (
    <button
      onClick={() =>
        c.kind === "dm" && c.memberId
          ? onNavigate({ type: "dm", memberId: c.memberId })
          : c.roomId
            ? onNavigate({ type: "room", id: c.roomId })
            : undefined
      }
      className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left cursor-pointer transition-colors ${active ? "bg-accent-dim" : "hover:bg-surface-2"}`}
    >
      {c.kind === "dm" ? (
        <StaffBadge name={c.title} status={statusFromAgent(c.status ?? "idle")} size="sm" />
      ) : (
        <div className="w-6 h-6 rounded-md bg-accent-dim text-accent-ink flex items-center justify-center shrink-0">
          <Hash size={12} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className={`text-[12.5px] truncate ${c.unreadCount > 0 ? "font-bold text-ink-1" : "font-medium text-ink-2"}`}>{c.title}</div>
        <div className="text-[10.5px] text-ink-4 truncate">
          {c.lastMessage ? c.lastMessage.text.replace(/\s+/g, " ").slice(0, 42) : "No messages yet"}
        </div>
      </div>
      {c.mentioned && (
        <span className="shrink-0 w-[18px] h-[18px] rounded-full bg-blocked text-white text-[10px] font-bold flex items-center justify-center">@</span>
      )}
      {c.unreadCount > 0 && (
        <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-accent-contrast text-[10px] font-bold flex items-center justify-center tabular-nums">
          {c.unreadCount > 99 ? "99+" : c.unreadCount}
        </span>
      )}
    </button>
  );
}


/** Chats "+" pop (fish 2026-08-25): two creation paths — a new room, or a
 * one-click member birth. Same pop family as the workstation pops. */
function ChatsPlusMenu({ anchorRect, busy, error, onNewRoom, onNewMember, onClose }: {
  anchorRect: DOMRect;
  busy: boolean;
  error: string | null;
  onNewRoom: () => void;
  onNewMember: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = 156;
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const item = "w-full flex items-center gap-2 text-left text-[12px] px-2.5 py-2 rounded cursor-pointer transition-colors text-ink-2 hover:bg-surface-2 hover:text-ink-1 disabled:opacity-50";
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchorRect.right - width));
  return createPortal(
    <div ref={ref} className="fixed z-50 bg-surface-3 border border-line-strong rounded-lg p-1" style={{ left, width, top: anchorRect.bottom + 6, boxShadow: "var(--shadow-pop)" }}>
      <button type="button" onClick={onNewRoom} className={item}>
        <Hash size={12} className="text-ink-4 shrink-0" /> New room
      </button>
      <button type="button" onClick={onNewMember} disabled={busy} className={item}>
        {busy ? <Loader2 size={12} className="text-ink-4 shrink-0 animate-spin" /> : <Contact size={12} className="text-ink-4 shrink-0" />}
        New member
      </button>
      {error && <div role="alert" className="text-[10.5px] text-blocked px-2.5 pt-0.5 pb-1">{error}</div>}
    </div>,
    document.body,
  );
}
