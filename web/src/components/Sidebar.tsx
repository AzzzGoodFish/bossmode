import { useState, useEffect, useMemo } from "react";
import {
  LogOut, BookOpen, MessageSquare, Settings, Sun, Moon,
  CheckSquare, Plus, Users,
} from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import type { Room, AgentInfo, SkillInfo, KnowledgeTreeNode, TeamTemplateSummary } from "../api/client";
import { getRooms, getAgents, getSkills, getKnowledgeTree, getTeams } from "../api/client";
import { StaffBadge, statusFromAgent } from "./StaffBadge";

export type SettingsSection = "models" | "runtime" | "summary" | "integrations" | "team-updates";

export type ActivePage =
  | { type: "room"; id: string }
  | { type: "team"; name: string | null }
  | { type: "agent"; name: string | null }
  | { type: "skill"; name: string | null }
  | { type: "knowledge"; path?: string }
  | { type: "settings"; section?: SettingsSection }
  | { type: "all-tasks" }
  | { type: "task"; roomId: string; taskId: string; from?: "chat" | "tasks" | "all-tasks" }
  | null;

type Domain = "rooms" | "team" | "library" | "system";

export function domainOf(page: ActivePage): Domain {
  switch (page?.type) {
    case "team":
    case "agent":
    case "skill":
      return "team";
    case "knowledge":
      return "library";
    case "settings":
      return "system";
    default:
      return "rooms";
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
}

const SYSTEM_SECTIONS: Array<{ id: SettingsSection; title: string; desc: string }> = [
  { id: "models", title: "Models", desc: "Connect providers and choose available models." },
  { id: "runtime", title: "Runtime", desc: "Session continuity and connection recovery." },
  { id: "summary", title: "Summarization", desc: "Choose when long conversations are summarized." },
  { id: "integrations", title: "Integrations", desc: "Connect external tools and services." },
  { id: "team-updates", title: "Built-in Updates", desc: "Updates for built-in Agents and Skills." },
];

type RoomPresence = "working" | "idle" | "offline";

function roomPresence(room: Room): { state: RoomPresence; title: string } {
  const memberStatuses = room.members.map((m) => room.agentStatuses?.[m] || "inactive");
  const workingCount = memberStatuses.filter((s) => s === "working" || s === "thinking").length;
  const idleCount = memberStatuses.filter((s) => s === "idle").length;
  const memberCount = room.members.length;

  if (workingCount > 0) return { state: "working", title: `${workingCount} working · ${memberCount} members` };
  if (idleCount > 0) return { state: "idle", title: `${idleCount} idle · ${memberCount} members` };
  return { state: "offline", title: `offline · ${memberCount} members` };
}

function roomBeaconClass(state: RoomPresence): string {
  switch (state) {
    case "working":
      return "bg-onair shadow-[0_0_0_3px_color-mix(in_srgb,var(--on-air)_14%,transparent),0_0_12px_color-mix(in_srgb,var(--on-air)_46%,transparent)] animate-pulse";
    case "idle":
      return "bg-onair opacity-85 shadow-[0_0_0_3px_color-mix(in_srgb,var(--on-air)_10%,transparent)]";
    default:
      return "bg-idleg opacity-60 shadow-[0_0_0_3px_color-mix(in_srgb,var(--idle-g)_8%,transparent)]";
  }
}

export function Sidebar({
  activePage, username, onNavigate, onLogout, refreshKey,
  unreadRoomIds, onRoomsLoaded, liveRooms, collapsed, onToggle,
}: SidebarProps) {
  const isMobile = useIsMobile();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [teams, setTeams] = useState<TeamTemplateSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [knowledgeFolders, setKnowledgeFolders] = useState<KnowledgeTreeNode[]>([]);

  // Derive the active domain from the page while allowing rail-only browsing.
  const pageDomain = domainOf(activePage);
  const [browseDomain, setBrowseDomain] = useState<Domain | null>(null);
  const domain: Domain = browseDomain ?? pageDomain;
  useEffect(() => { setBrowseDomain(null); }, [activePage]);

  const refresh = () => {
    getRooms().then(setRooms).catch(console.error);
    getTeams().then(setTeams).catch(() => setTeams([]));
    getAgents().then(setAgents).catch(console.error);
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

  const displayRooms = liveRooms ?? rooms;

  const selectedRoomId = activePage?.type === "room" ? activePage.id : null;
  const selectedTeamName = activePage?.type === "team" ? activePage.name : null;
  const selectedAgentName = activePage?.type === "agent" ? activePage.name : null;
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
      <button onClick={() => setBrowseDomain("rooms")} title="Rooms" aria-label="Rooms" className={railBtn(domain === "rooms")}>
        {domain === "rooms" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <MessageSquare size={18} />
        {hasAnyUnreadRoom && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-accent" />}
      </button>
      <button onClick={() => { setBrowseDomain("team"); onNavigate({ type: "team", name: null }); }} title="Team" aria-label="Team" className={railBtn(domain === "team")}>
        {domain === "team" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <Users size={18} />
      </button>
      <button onClick={() => setBrowseDomain("library")} title="Library" aria-label="Library" className={railBtn(domain === "library")}>
        {domain === "library" && <span className="absolute -left-[7px] top-2 bottom-2 w-0.5 rounded bg-accent" />}
        <BookOpen size={18} />
      </button>
      <div className="flex-1" />
      <button onClick={toggleTheme} title="Toggle theme" aria-label="Toggle theme" className={railBtn(false)}>
        <Sun size={16} className="hidden dark:block" />
        <Moon size={16} className="block dark:hidden" />
      </button>
      <button
        onClick={() => setBrowseDomain("system")}
        title="Settings"
        aria-label="Settings"
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
  const panelTitle = { rooms: "Rooms", team: "Team", library: "Library", system: "Settings" }[domain];

  const itemCls = (active: boolean) =>
    `w-full text-left rounded-lg px-2.5 py-2 mb-px transition-colors cursor-pointer ${
      active ? "bg-surface-2" : "hover:bg-surface-1"
    }`;
  const roomItemCls = (active: boolean) =>
    `w-full text-left rounded-lg pl-2.5 pr-7 py-2 mb-px transition-colors cursor-pointer ${
      active ? "bg-surface-2" : "hover:bg-surface-1"
    }`;

  const panel = (
    <aside className="w-[236px] shrink-0 bg-surface-0 border-r border-line flex flex-col min-h-0">
      <div className="h-12 shrink-0 flex items-center justify-between px-3.5 border-b border-line-soft">
        <h1 className="text-[13px] font-semibold text-ink-1">{panelTitle}</h1>
        {domain === "rooms" && (
          <button
            onClick={() => onNavigate({ type: "room", id: "__new__" })}
            title="New room"
            className="w-6 h-6 border border-line rounded-md text-ink-3 hover:text-accent-ink hover:border-line-strong flex items-center justify-center cursor-pointer transition-colors"
          >
            <Plus size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-2">
        {domain === "rooms" && (
          <>
            {displayRooms.map((r) => {
              const presence = roomPresence(r);
              return (
                <div key={r.id} className="group relative">
                  <button
                    onClick={() => onNavigate({ type: "room", id: r.id })}
                    className={roomItemCls(selectedRoomId === r.id)}
                    title={presence.title}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`text-[12.5px] font-medium truncate flex-1 ${selectedRoomId === r.id ? "text-ink-1" : "text-ink-2"}`}>
                        {r.name}
                      </span>
                      {unreadRoomIds?.has(r.id) && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />}
                    </div>
                    <div className="font-mono text-[10.5px] text-ink-4 truncate mt-px">
                      ~{r.cwd.replace(/^\/home\/[^/]+/, "")}
                    </div>
                  </button>
                  <span
                    className="absolute right-3 top-[17px] w-3 h-3 grid place-items-center pointer-events-none"
                    title={presence.title}
                    aria-label={presence.title}
                  >
                    <span className={`w-[7px] h-[7px] rounded-full ${roomBeaconClass(presence.state)}`} />
                  </span>
                </div>
              );
            })}
            {rooms.length === 0 && (
              <p className="text-xs text-ink-4 px-2.5 py-2">No Rooms yet. Click + to create one.</p>
            )}
          </>
        )}

        {domain === "team" && (
          <>
            <SectionHead label={`TEAMS · ${teams.length}`} onCreate={() => onNavigate({ type: "team", name: null })} />
            <button onClick={() => onNavigate({ type: "team", name: null })} className={itemCls(activePage?.type === "team" && activePage.name === null)}>
              <span className="text-[12.5px] font-medium text-ink-2">All teams</span>
            </button>
            {teams.map((t) => (
              <button key={t.name} onClick={() => onNavigate({ type: "team", name: t.name })} className={itemCls(selectedTeamName === t.name)}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="w-6 h-6 rounded-md bg-accent-dim text-accent-ink flex items-center justify-center text-[10px] font-bold shrink-0">{(t.name[0] || "?").toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <span className={`block text-[12.5px] font-medium truncate ${selectedTeamName === t.name ? "text-ink-1" : "text-ink-2"}`}>{t.name}</span>
                    <span className="block text-[10px] text-ink-4 truncate">{(t.agentNames ?? []).length} agents · {t.version}</span>
                  </div>
                </div>
              </button>
            ))}
            <div className="h-3" />
            <SectionHead label={`AGENTS · ${agents.length}`} onCreate={() => onNavigate({ type: "agent", name: "__new__" })} />
            <button onClick={() => onNavigate({ type: "agent", name: null })} className={itemCls(activePage?.type === "agent" && activePage.name === null)}>
              <span className="text-[12.5px] font-medium text-ink-2">All agents</span>
            </button>
            {agents.map((a) => (
              <button key={a.name} onClick={() => onNavigate({ type: "agent", name: a.name })} className={itemCls(selectedAgentName === a.name)}>
                <div className="flex items-center gap-2.5">
                  <StaffBadge name={a.name} avatar={a.avatar} status="idle" size="sm" />
                  <span className={`text-[12.5px] font-medium truncate ${selectedAgentName === a.name ? "text-ink-1" : "text-ink-2"}`}>{a.name}</span>
                </div>
              </button>
            ))}
            <div className="h-3" />
            <SectionHead label={`SKILLS · ${skills.length}`} onCreate={() => onNavigate({ type: "skill", name: "__new__" })} />
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

      {domain === "rooms" && (
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

function SectionHead({ label, onCreate }: { label: string; onCreate?: () => void }) {
  return (
    <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5">
      <span className="text-[10.5px] font-semibold tracking-[0.05em] text-ink-4">{label}</span>
      {onCreate && (
        <button onClick={onCreate} className="text-ink-4 hover:text-accent-ink cursor-pointer transition-colors" title="Create">
          <Plus size={12} />
        </button>
      )}
    </div>
  );
}
