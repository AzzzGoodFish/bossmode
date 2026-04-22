import { useState, useEffect } from "react";
import { Hash, LogOut, Bot, Puzzle, BookOpen, MessageSquare, UserCircle, Settings, Sun, Moon, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Room, AgentInfo, MemberInfo, SkillInfo } from "../api/client";
import { getRooms, getAgents, getMembers, getSkills } from "../api/client";
import { SidebarSection, type SidebarItem } from "./SidebarSection";
import { RoomMenu } from "./RoomMenu";
import { RoomSettingsDialog } from "./RoomSettingsDialog";
import { useDialog } from "./dialogs";

export type ActivePage =
  | { type: "room"; id: string }
  | { type: "member"; id: string | null }
  | { type: "agent"; name: string | null }
  | { type: "skill"; name: string | null }
  | { type: "knowledge"; path?: string }
  | { type: "settings" }
  | null;

interface SidebarProps {
  activePage: ActivePage;
  username: string;
  onNavigate: (page: ActivePage) => void;
  onLogout: () => void;
  refreshKey?: number; // increment to trigger data refresh
  unreadRoomIds?: Set<string>;
  onRoomsLoaded?: (rooms: Room[]) => void;
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ activePage, username, onNavigate, onLogout, refreshKey, unreadRoomIds, onRoomsLoaded, collapsed, onToggle }: SidebarProps) {
  const { toast, confirm, prompt } = useDialog();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [settingsRoomId, setSettingsRoomId] = useState<string | null>(null);

  const refresh = () => {
    getRooms().then(setRooms).catch(console.error);
    getAgents().then(setAgents).catch(console.error);
    getMembers().then(setMembers).catch(console.error);
    getSkills().then(setSkills).catch(console.error);
  };

  useEffect(() => { refresh(); }, [refreshKey]);

  // Expose rooms for Layout
  useEffect(() => {
    (window as any).__bossmode_rooms = rooms;
    (window as any).__bossmode_refreshSidebar = refresh;
    onRoomsLoaded?.(rooms);
  }, [rooms, onRoomsLoaded]);

  // Selected IDs
  const selectedRoomId = activePage?.type === "room" ? activePage.id : null;
  const selectedMemberId = activePage?.type === "member" ? activePage.id : null;
  const selectedAgentName = activePage?.type === "agent" ? activePage.name : null;
  const selectedSkillName = activePage?.type === "skill" ? activePage.name : null;
  const isKnowledgeActive = activePage?.type === "knowledge";

  // Map data to SidebarItems
  const roomItems: SidebarItem[] = rooms.map((r) => ({
    id: r.id,
    icon: <Hash size={14} />,
    label: r.name,
    sublabel: r.cwd.split("/").slice(-2).join("/"),
    hasUnread: unreadRoomIds?.has(r.id),
  }));

  const memberItems: SidebarItem[] = members.map((m) => ({
    id: m.id,
    label: m.name,
    sublabel: `${m.runtime} · ${m.model}`,
  }));

  const agentItems: SidebarItem[] = agents.map((a) => ({
    id: a.name,
    icon: <span className="text-base">{a.avatar || "🤖"}</span>,
    label: a.name,
    sublabel: a.description?.slice(0, 40),
  }));

  const skillItems: SidebarItem[] = skills.map((s) => ({
    id: s.name,
    label: s.name,
    sublabel: s.description?.slice(0, 40),
  }));

  const hasAnyUnreadRoom = (unreadRoomIds?.size || 0) > 0;
  const settingsRoom = settingsRoomId ? rooms.find((r) => r.id === settingsRoomId) || null : null;

  const toggleTheme = () => {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("bossmode_theme", isDark ? "dark" : "light");
  };

  const collapsedIconBtn = (active: boolean) =>
    `w-full h-10 flex items-center justify-center transition-colors cursor-pointer relative ${
      active
        ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white"
        : "text-zinc-500 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300"
    }`;

  return (
    <div className={`${collapsed ? "w-12" : "w-56"} border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out`}>
      {/* Header */}
      <div className="h-12 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        {collapsed ? (
          <div className="h-full flex items-center justify-center">
            <button
              onClick={onToggle}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="text-zinc-400 dark:text-zinc-600 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <PanelLeftOpen size={16} />
            </button>
          </div>
        ) : (
          <div className="h-full flex items-center justify-between px-4">
            <span className="font-bold text-sm text-zinc-900 dark:text-white tracking-tight whitespace-nowrap">Bossmode</span>
            <button
              onClick={onToggle}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
              className="text-zinc-400 dark:text-zinc-600 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors cursor-pointer p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      {collapsed ? (
        <div className="flex-1 min-h-0 flex flex-col py-1">
          <button
            onClick={() => {
              onNavigate({ type: "room", id: selectedRoomId || rooms[0]?.id || "__new__" });
              onToggle();
            }}
            title="Rooms"
            aria-label="Rooms"
            className={collapsedIconBtn(activePage?.type === "room")}
          >
            <MessageSquare size={18} />
            {hasAnyUnreadRoom && <span className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-red-500" />}
          </button>
          <button
            onClick={() => {
              onNavigate({ type: "member", id: selectedMemberId || members[0]?.id || null });
              onToggle();
            }}
            title="Members"
            aria-label="Members"
            className={collapsedIconBtn(activePage?.type === "member")}
          >
            <UserCircle size={18} />
          </button>
          <button
            onClick={() => {
              onNavigate({ type: "agent", name: selectedAgentName || agents[0]?.name || null });
              onToggle();
            }}
            title="Agents"
            aria-label="Agents"
            className={collapsedIconBtn(activePage?.type === "agent")}
          >
            <Bot size={18} />
          </button>
          <button
            onClick={() => {
              onNavigate({ type: "skill", name: selectedSkillName || skills[0]?.name || null });
              onToggle();
            }}
            title="Skills"
            aria-label="Skills"
            className={collapsedIconBtn(activePage?.type === "skill")}
          >
            <Puzzle size={18} />
          </button>
          <button
            onClick={() => {
              onNavigate({ type: "knowledge" });
              onToggle();
            }}
            title="Knowledge"
            aria-label="Knowledge"
            className={collapsedIconBtn(isKnowledgeActive)}
          >
            <BookOpen size={18} />
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="mt-1">
            <SidebarSection
              icon={<MessageSquare size={14} />}
              label="Rooms"
              count={rooms.length}
              items={roomItems}
              selectedId={selectedRoomId}
              storageKey="rooms"
              onSelect={(id) => onNavigate({ type: "room", id })}
              onCreate={() => onNavigate({ type: "room", id: "__new__" })}
              renderMenu={(id) => (
                <RoomMenu
                  onRename={async () => {
                    const newName = await prompt("New room name:");
                    if (!newName) return;
                    try {
                      const { updateRoomSettings } = await import("../api/client");
                      await updateRoomSettings(id, { name: newName });
                      refresh();
                    } catch (err: any) { toast(err.message, "error"); }
                  }}
                  onSettings={() => setSettingsRoomId(id)}
                  onDelete={async () => {
                    if (!(await confirm("Delete this room?"))) return;
                    try {
                      const { deleteRoom } = await import("../api/client");
                      await deleteRoom(id);
                      refresh();
                      if (selectedRoomId === id) onNavigate(null);
                    } catch (err: any) { toast(err.message, "error"); }
                  }}
                />
              )}
            />
          </div>

          <div className="border-t border-zinc-200 dark:border-zinc-800 mt-1 pt-1">
            <SidebarSection
              icon={<UserCircle size={14} />}
              label="Members"
              count={members.length}
              items={memberItems}
              selectedId={selectedMemberId}
              storageKey="members"
              defaultOpen={true}
              onSelect={(id) => onNavigate({ type: "member", id })}
              onCreate={() => onNavigate({ type: "member", id: null })}
            />

            <div className="border-t border-zinc-200 dark:border-zinc-800/50 mt-1 pt-1" />
            <SidebarSection
              icon={<Bot size={14} />}
              label="Agents"
              count={agents.length}
              items={agentItems}
              selectedId={selectedAgentName}
              storageKey="agents"
              defaultOpen={false}
              onSelect={(name) => onNavigate({ type: "agent", name })}
              onCreate={() => onNavigate({ type: "agent", name: null })}
            />

            <SidebarSection
              icon={<Puzzle size={14} />}
              label="Skills"
              count={skills.length}
              items={skillItems}
              selectedId={selectedSkillName}
              storageKey="skills"
              defaultOpen={false}
              onSelect={(name) => onNavigate({ type: "skill", name })}
              onCreate={() => onNavigate({ type: "skill", name: null })}
            />

            <button
              onClick={() => onNavigate({ type: "knowledge" })}
              className={`w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors cursor-pointer ${
                isKnowledgeActive
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white"
                  : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300"
              }`}
            >
              <BookOpen size={14} className="text-zinc-500" />
              <span>Knowledge</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom */}
      {collapsed ? (
        <div className="border-t border-zinc-200 dark:border-zinc-800 shrink-0 flex flex-col items-center py-2 gap-1">
          <button
            onClick={() => {
              onNavigate({ type: "settings" });
              onToggle();
            }}
            title="Settings"
            aria-label="Settings"
            className={`w-10 h-10 flex items-center justify-center rounded transition-colors cursor-pointer ${
              activePage?.type === "settings"
                ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white"
                : "text-zinc-500 dark:text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300"
            }`}
          >
            <Settings size={18} />
          </button>
          <button
            onClick={toggleTheme}
            title="Toggle theme"
            aria-label="Toggle theme"
            className="w-10 h-10 flex items-center justify-center rounded text-zinc-500 dark:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <Sun size={16} className="hidden dark:block" />
            <Moon size={16} className="block dark:hidden" />
          </button>
          <button
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
            className="w-10 h-10 flex items-center justify-center rounded text-zinc-500 dark:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <LogOut size={16} />
          </button>
          <div className="w-7 h-7 rounded-full bg-zinc-300 dark:bg-zinc-700 flex items-center justify-center text-xs text-zinc-600 dark:text-zinc-400 mt-1">
            {username.charAt(0).toUpperCase()}
          </div>
        </div>
      ) : (
        <div className="border-t border-zinc-200 dark:border-zinc-800 shrink-0">
          <button
            onClick={() => onNavigate({ type: "settings" })}
            className={`w-full flex items-center gap-2 px-4 py-2 text-sm transition-colors cursor-pointer ${
              activePage?.type === "settings" ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white" : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 hover:text-zinc-900 dark:hover:text-zinc-300"
            }`}
          >
            <Settings size={14} className="text-zinc-500" />
            <span>Settings</span>
          </button>
          <div className="px-3 py-2.5 flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-6 h-6 rounded-full bg-zinc-300 dark:bg-zinc-700 flex items-center justify-center text-xs text-zinc-600 dark:text-zinc-400 shrink-0">
                {username.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm text-zinc-600 dark:text-zinc-400 truncate">{username}</span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={toggleTheme} className="text-zinc-500 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer p-0.5" title="Toggle theme">
                <Sun size={14} className="hidden dark:block" />
                <Moon size={14} className="block dark:hidden" />
              </button>
              <button onClick={onLogout} className="text-zinc-500 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer p-0.5" title="Sign out">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsRoom && (
        <RoomSettingsDialog
          room={settingsRoom}
          open={!!settingsRoom}
          onClose={() => setSettingsRoomId(null)}
          onSaved={(updatedRoom) => {
            setRooms((prev) => prev.map((r) => (r.id === updatedRoom.id ? updatedRoom : r)));
            setSettingsRoomId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
