import { useState, useEffect, useMemo } from "react";
import {
  LogOut, BookOpen, MessageSquare, Settings, Sun, Moon,
  CheckSquare, Plus, Contact, Hash, Fingerprint, Puzzle, Search, MessagesSquare,
  Folder, LayoutTemplate,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Room, SkillInfo, KnowledgeTreeNode } from "../api/client";
import { getRooms, getSkills, getKnowledgeTree, getChats, getTemplates, type ChatEntry, type TemplateInfo } from "../api/client";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { HelpMenu } from "./HelpMenu";

export type SettingsSection = "models" | "runtime" | "prompt" | "integrations" | "extensions" | "usage";

export type ActivePage =
  | { type: "chats" }
  | { type: "contacts" }
  | { type: "dm"; memberId: string }
  | { type: "member-create" }
  | { type: "member-settings"; memberId: string }
  | { type: "templates"; name?: string; create?: boolean }
  | { type: "room"; id: string }
  | { type: "topic"; roomId: string; topicId: string }
  /** Topic draft (topic-threads v3, fish): opened from a message's topic button; nothing persists until the first message sends. */
  | { type: "topic-draft"; roomId: string; anchorMessageId: string; anchorSeq?: number; anchorTitle: string; anchorExcerpt: string }
  | { type: "skill"; name: string | null }
  | { type: "knowledge"; path?: string }
  | { type: "settings"; section?: SettingsSection }
  | { type: "all-tasks" }
  | { type: "task"; roomId: string; taskId: string; from?: "chat" | "tasks" | "all-tasks" }
  | null;

type Domain = "chats" | "templates" | "skills" | "library" | "system";

export function domainOf(page: ActivePage): Domain {
  switch (page?.type) {
    case "chats":
      return "chats";
    case "contacts":
    case "dm":
    case "member-create":
    case "member-settings":
      return "chats";
    case "templates":
      return "templates";
    case "skill":
      return "skills";
    case "knowledge":
      return "library";
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
  { id: "runtime", title: "Runtime", desc: "Session continuity and connection recovery." },
  { id: "prompt", title: "Prompt", desc: "Environment & Communication asset every member sees." },
  { id: "extensions", title: "Extensions", desc: "Install pi agent extensions (e.g. web search)." },
  { id: "integrations", title: "Integrations", desc: "Connect external tools and services." },
  { id: "usage", title: "Usage", desc: "Token consumption by identity, room and time" },
];



export function Sidebar({
  activePage, username, onNavigate, onLogout, refreshKey,
  unreadRoomIds, onRoomsLoaded, liveRooms, collapsed, onToggle,
  onReplayTour,
}: SidebarProps) {
  const isMobile = useIsMobile();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [knowledgeFolders, setKnowledgeFolders] = useState<KnowledgeTreeNode[]>([]);

  // Derive the active domain from the page while allowing rail-only browsing.
  const pageDomain = domainOf(activePage);
  const [browseDomain, setBrowseDomain] = useState<Domain | null>(null);
  const domain: Domain = browseDomain ?? pageDomain;
  useEffect(() => { setBrowseDomain(null); }, [activePage]);

  const refresh = () => {
    getRooms().then(setRooms).catch(console.error);
    getSkills().then(setSkills).catch(console.error);
    getKnowledgeTree()
      .then((root) => {
        const folders = (root.children ?? []).filter((c) => c.kind === "folder");
        setKnowledgeFolders(folders);
      })
      .catch(console.error);
  };

  useEffect(() => { refresh(); }, [refreshKey]);

  useEffect(() => {
    (window as any).__bossmode_rooms = rooms;
    (window as any).__bossmode_refreshSidebar = refresh;
    onRoomsLoaded?.(rooms);
  }, [rooms, onRoomsLoaded]);


  const selectedSkillName = activePage?.type === "skill" ? activePage.name : null;
  const selectedKnowledgeFolder =
    activePage?.type === "knowledge" && activePage.path ? activePage.path.split("/")[0] : null;
  const activeSettingsSection = activePage?.type === "settings" ? (activePage.section ?? "models") : null;

  const hasAnyUnreadRoom = (unreadRoomIds?.size || 0) > 0;
  const openTasksLabel = useMemo(() => "All Tasks", []);

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
      <button onClick={() => { setBrowseDomain("templates"); onNavigate({ type: "templates" }); }} title="Templates" aria-label="Templates" className={railBtn(domain === "templates")}>
        {domain === "templates" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <Fingerprint size={18} />
      </button>
      <button onClick={() => { setBrowseDomain("skills"); onNavigate({ type: "skill", name: null }); }} title="Skills" aria-label="Skills" className={railBtn(domain === "skills")}>
        {domain === "skills" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <Puzzle size={18} />
      </button>
      <button onClick={() => { setBrowseDomain("library"); onNavigate({ type: "knowledge" }); }} title="Library" aria-label="Library" className={railBtn(domain === "library")}>
        {domain === "library" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <BookOpen size={18} />
      </button>
      <div className="w-5 h-px bg-line-soft my-1.5" />
      <button onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme" className={railBtn(false)}>
        <Sun size={16} className="hidden dark:block" />
        <Moon size={16} className="block dark:hidden" />
      </button>
      {onReplayTour && (
        <HelpMenu
          onReplayTour={onReplayTour}
          onOpenDocs={() => onNavigate({ type: "knowledge" })}
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
  const panelTitle = { chats: "Chats", templates: "Templates", skills: "Skills", library: "Library", system: "Settings" }[domain];

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
          <button
            onClick={() => onNavigate({ type: "room", id: "__new__" })}
            title="New room"
            data-tour="new-room"
            className={createBtn}
          >
            <Plus size={13} />
          </button>
        )}
        {domain === "templates" && (
          <button
            onClick={() => onNavigate({ type: "templates", create: true })}
            title="New template"
            className={createBtn}
          >
            <Plus size={13} />
          </button>
        )}
        {domain === "library" && (
          <button
            onClick={() => onNavigate({ type: "knowledge", path: "__new__" })}
            title="New document"
            className={createBtn}
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {domain === "chats" && <ChatsPanelList activePage={activePage} onNavigate={onNavigate} />}
        {domain === "templates" && <TemplatesPanelList activePage={activePage} onNavigate={onNavigate} />}

        {domain === "skills" && (
          <>
            <SectionHead
              label={`SKILLS · ${skills.length}`}
              onLabelClick={() => onNavigate({ type: "skill", name: null })}
              active={activePage?.type === "skill" && activePage.name === null}
            />
            {skills.map((s) => (
              <button key={s.name} onClick={() => onNavigate({ type: "skill", name: s.name })} className={itemCls(selectedSkillName === s.name)}>
                <div className="flex items-center gap-2.5">
                  {leadBlock(<Puzzle size={12} />)}
                  <span className={`text-[12.5px] font-medium truncate ${selectedSkillName === s.name ? "text-ink-1" : "text-ink-2"}`}>{s.name}</span>
                </div>
              </button>
            ))}
          </>
        )}


        {domain === "library" && (
          <>
            <SectionHead
              label={`LIBRARY · ${knowledgeFolders.length}`}
              onLabelClick={() => onNavigate({ type: "knowledge" })}
              active={activePage?.type === "knowledge" && !activePage.path}
            />
            <button onClick={() => onNavigate({ type: "knowledge" })} className={itemCls(activePage?.type === "knowledge" && !activePage.path)}>
              <div className="flex items-center gap-2.5">
                {leadBlock(<BookOpen size={12} />)}
                <span className="text-[12.5px] font-medium text-ink-2">All documents</span>
              </div>
            </button>
            {knowledgeFolders.map((f) => (
              <button key={f.path} onClick={() => onNavigate({ type: "knowledge", path: f.path })} className={itemCls(selectedKnowledgeFolder === f.name)}>
                <div className="flex items-center gap-2.5">
                  {leadBlock(<Folder size={12} />)}
                  <span className={`text-[12.5px] font-medium truncate ${selectedKnowledgeFolder === f.name ? "text-ink-1" : "text-ink-2"}`}>{f.name}</span>
                </div>
              </button>
            ))}
          </>
        )}

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

      {domain === "chats" && (
        <div className="border-t border-line-soft shrink-0 p-2 space-y-px">
          <button
            onClick={() => onNavigate({ type: "contacts" })}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px] transition-colors cursor-pointer ${
              activePage?.type === "contacts" || activePage?.type === "member-create"
                ? "bg-surface-2 text-ink-1"
                : "text-ink-3 hover:bg-surface-1 hover:text-ink-2"
            }`}
          >
            <Contact size={14} />
            <span>Contacts</span>
          </button>
          <button
            onClick={() => onNavigate({ type: "all-tasks" })}
            className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[12.5px] transition-colors cursor-pointer ${
              activePage?.type === "all-tasks" || activePage?.type === "task"
                ? "bg-surface-2 text-ink-1"
                : "text-ink-3 hover:bg-surface-1 hover:text-ink-2"
            }`}
          >
            <CheckSquare size={14} />
            <span>{openTasksLabel}</span>
          </button>
        </div>
      )}
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
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = () => getChats().then((r) => { if (!cancelled) setChats(r.chats); }).catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);
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

function TemplatesPanelList({ activePage, onNavigate }: { activePage: ActivePage; onNavigate: (p: ActivePage) => void }) {
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    getTemplates().then((r) => { if (!cancelled) setTemplates(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (!templates) return <div className="px-2 py-3 text-[11.5px] text-ink-4">Loading…</div>;
  return (
    <>
      <SectionHead
        label={`TEMPLATES · ${templates.length}`}
        onLabelClick={() => onNavigate({ type: "templates" })}
        active={activePage?.type === "templates" && !activePage.name}
      />
      {templates.map((t) => {
        const active = activePage?.type === "templates" && activePage.name === t.name;
        return (
          <button
            key={t.name}
            onClick={() => onNavigate({ type: "templates", name: t.name })}
            className={`w-full text-left rounded-lg px-2.5 py-2 mb-px transition-colors cursor-pointer ${active ? "bg-accent-dim" : "hover:bg-surface-1"}`}
          >
            <div className="flex items-center gap-2.5">
              <span className="w-6 h-6 rounded-md bg-surface-2 border border-line-soft text-ink-3 flex items-center justify-center shrink-0"><LayoutTemplate size={12} /></span>
              <div className="min-w-0 flex-1">
                <div className={`text-[12.5px] font-medium truncate ${active ? "text-ink-1" : "text-ink-2"}`}>{t.name}</div>
                <div className="text-[10.5px] text-ink-4 truncate">{t.builtin ? "built-in" : `${t.referencedBy.length} member${t.referencedBy.length === 1 ? "" : "s"}`}</div>
              </div>
            </div>
          </button>
        );
      })}
    </>
  );
}
