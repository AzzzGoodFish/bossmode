import { useState, useEffect, useMemo } from "react";
import {
  LogOut, BookOpen, MessageSquare, Settings, Sun, Moon,
  CheckSquare, Plus, Contact, Hash, Fingerprint, Puzzle,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Room, SkillInfo, KnowledgeTreeNode } from "../api/client";
import { getRooms, getSkills, getKnowledgeTree, getChats, getContacts, getTemplates, type ChatEntry, type ContactEntry, type TemplateInfo } from "../api/client";
import { StaffBadge, statusFromAgent } from "./StaffBadge";
import { HelpMenu } from "./HelpMenu";

export type SettingsSection = "models" | "runtime" | "integrations" | "extensions" | "usage";

export type ActivePage =
  | { type: "chats" }
  | { type: "contacts" }
  | { type: "dm"; memberId: string }
  | { type: "member-create" }
  | { type: "member-settings"; memberId: string }
  | { type: "templates"; name?: string }
  | { type: "room"; id: string }
  | { type: "skill"; name: string | null }
  | { type: "knowledge"; path?: string }
  | { type: "settings"; section?: SettingsSection }
  | { type: "all-tasks" }
  | { type: "task"; roomId: string; taskId: string; from?: "chat" | "tasks" | "all-tasks" }
  | null;

type Domain = "chats" | "contacts" | "templates" | "skills" | "library" | "system";

export function domainOf(page: ActivePage): Domain {
  switch (page?.type) {
    case "chats":
      return "chats";
    case "contacts":
    case "dm":
    case "member-create":
    case "member-settings":
      return "contacts";
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
      <button onClick={() => { setBrowseDomain("contacts"); onNavigate({ type: "contacts" }); }} title="Contacts" aria-label="Contacts" className={railBtn(domain === "contacts")}>
        {domain === "contacts" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <Contact size={18} />
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
  const panelTitle = { chats: "Chats", contacts: "Contacts", templates: "Templates", skills: "Skills", library: "Library", system: "Settings" }[domain];

  const itemCls = (active: boolean) =>
    `w-full text-left rounded-lg px-2.5 py-2 mb-px transition-colors cursor-pointer ${
      active ? "bg-surface-2" : "hover:bg-surface-1"
    }`;

  const panel = (
    <aside className="w-[236px] shrink-0 bg-surface-0 border-r border-line flex flex-col min-h-0">
      <div className="h-12 shrink-0 flex items-center justify-between px-3.5 border-b border-line-soft">
        <h1 className="text-[13px] font-semibold text-ink-1">{panelTitle}</h1>
        {domain === "chats" && (
          <button
            onClick={() => onNavigate({ type: "room", id: "__new__" })}
            title="New room"
            data-tour="new-room"
            className="w-6 h-6 border border-line rounded-md text-ink-3 hover:text-accent-ink hover:border-line-strong flex items-center justify-center cursor-pointer transition-colors"
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {domain === "chats" && <ChatsPanelList activePage={activePage} onNavigate={onNavigate} />}
        {domain === "templates" && <TemplatesPanelList activePage={activePage} onNavigate={onNavigate} />}
        {domain === "contacts" && <ContactsPanelList activePage={activePage} onNavigate={onNavigate} />}

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
                  <span className="w-6 h-6 rounded-md bg-surface-2 text-ink-3 flex items-center justify-center text-[10px] shrink-0">◆</span>
                  <span className={`text-[12.5px] font-medium truncate ${selectedSkillName === s.name ? "text-ink-1" : "text-ink-2"}`}>{s.name}</span>
                </div>
              </button>
            ))}
          </>
        )}


        {domain === "library" && (
          <>
            <SectionHead label="KNOWLEDGE" onCreate={() => onNavigate({ type: "knowledge", path: "__new__" })} />
            <button onClick={() => onNavigate({ type: "knowledge" })} className={itemCls(activePage?.type === "knowledge" && !activePage.path)}>
              <span className="text-[12.5px] font-medium text-ink-2">All documents</span>
            </button>
            {knowledgeFolders.map((f) => (
              <button key={f.path} onClick={() => onNavigate({ type: "knowledge", path: f.path })} className={itemCls(selectedKnowledgeFolder === f.name)}>
                <span className={`text-[12.5px] font-medium truncate ${selectedKnowledgeFolder === f.name ? "text-ink-1" : "text-ink-2"}`}>{f.name}</span>
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
        <div className="border-t border-line-soft shrink-0 p-2">
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

function SectionHead({ label, onCreate, onLabelClick, active }: {
  label: string;
  onCreate?: () => void;
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
      {onCreate && (
        <button onClick={onCreate} className="text-ink-4 hover:text-accent-ink cursor-pointer transition-colors" title="Create">
          <Plus size={12} />
        </button>
      )}
    </div>
  );
}

/** Compact unified conversation list for the Chats panel domain. */
function ChatsPanelList({ activePage, onNavigate }: { activePage: ActivePage; onNavigate: (p: ActivePage) => void }) {
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
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
  if (!chats) return <div className="px-2 py-3 text-[11.5px] text-ink-4">Loading…</div>;
  if (sorted.length === 0) return <div className="px-2 py-3 text-[11.5px] text-ink-4">No conversations yet.</div>;
  return (
    <>
      {sorted.map((c) => {
        const active =
          (c.kind === "dm" && activePage?.type === "dm" && activePage.memberId === c.memberId) ||
          (c.kind === "room" && activePage?.type === "room" && activePage.id === c.roomId);
        return (
          <button
            key={c.scopeId}
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
            {c.unreadCount > 0 && (
              <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-accent-contrast text-[10px] font-bold flex items-center justify-center tabular-nums">
                {c.unreadCount > 99 ? "99+" : c.unreadCount}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

function ContactsPanelList({ activePage, onNavigate }: { activePage: ActivePage; onNavigate: (p: ActivePage) => void }) {
  const [contacts, setContacts] = useState<ContactEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => getContacts().then((r) => { if (!cancelled) setContacts(r.contacts); }).catch(() => {});
    load();
    const t = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, []);
  if (!contacts) return <div className="px-2 py-3 text-[11.5px] text-ink-4">Loading…</div>;
  if (contacts.length === 0) return <div className="px-2 py-3 text-[11.5px] text-ink-4">No members yet — hire one from Contacts.</div>;
  const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {sorted.map((m) => {
        const active = activePage?.type === "dm" && activePage.memberId === m.memberId;
        return (
          <button
            key={m.memberId}
            onClick={() => onNavigate({ type: "dm", memberId: m.memberId })}
            className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left cursor-pointer transition-colors ${active ? "bg-accent-dim" : "hover:bg-surface-2"}`}
          >
            <StaffBadge name={m.name} status={statusFromAgent(m.status)} size="sm" />
            <div className="min-w-0 flex-1">
              <div className={`text-[12.5px] font-medium truncate ${active ? "text-accent-ink" : "text-ink-2"}`}>{m.name}</div>
              <div className="text-[10.5px] text-ink-4 truncate">
                {m.status === "working" ? "Working" : m.agentTemplate}
              </div>
            </div>
          </button>
        );
      })}
    </>
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
      {templates.map((t) => {
        const active = activePage?.type === "templates" && activePage.name === t.name;
        return (
          <button
            key={t.name}
            onClick={() => onNavigate({ type: "templates", name: t.name })}
            className={`w-full text-left rounded-lg px-2.5 py-2 mb-px transition-colors cursor-pointer ${active ? "bg-surface-2" : "hover:bg-surface-1"}`}
          >
            <div className={`text-[12.5px] font-medium truncate ${active ? "text-ink-1" : "text-ink-2"}`}>{t.name}</div>
            <div className="text-[10.5px] text-ink-4 truncate">{t.builtin ? "built-in" : `${t.referencedBy.length} member${t.referencedBy.length === 1 ? "" : "s"}`}</div>
          </button>
        );
      })}
    </>
  );
}
