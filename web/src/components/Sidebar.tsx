import { useState, useEffect } from "react";
import { Hash, LogOut, Bot, Puzzle, BookOpen, MessageSquare, UserCircle, Settings, Sun, Moon } from "lucide-react";
import type { Room, AgentInfo, MemberInfo, SkillInfo, KnowledgeBaseInfo } from "../api/client";
import { getRooms, getAgents, getMembers, getSkills, getKnowledgeBases } from "../api/client";
import { SidebarSection, type SidebarItem } from "./SidebarSection";
import { RoomMenu } from "./RoomMenu";
import { useDialog } from "./dialogs";

export type ActivePage =
  | { type: "room"; id: string }
  | { type: "member"; id: string | null }
  | { type: "agent"; name: string | null }
  | { type: "skill"; name: string | null }
  | { type: "knowledge"; id: string | null; entryId?: string; entryTitle?: string }
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
}

export function Sidebar({ activePage, username, onNavigate, onLogout, refreshKey, unreadRoomIds, onRoomsLoaded }: SidebarProps) {
  const { toast, confirm, prompt } = useDialog();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseInfo[]>([]);

  const refresh = () => {
    getRooms().then(setRooms).catch(console.error);
    getAgents().then(setAgents).catch(console.error);
    getMembers().then(setMembers).catch(console.error);
    getSkills().then(setSkills).catch(console.error);
    getKnowledgeBases().then(setKnowledgeBases).catch(console.error);
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
  const selectedKbId = activePage?.type === "knowledge" ? activePage.id : null;

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

  const kbItems: SidebarItem[] = knowledgeBases.map((kb) => ({
    id: kb.id,
    label: kb.name,
    sublabel: kb.description?.slice(0, 40),
  }));

  return (
    <div className="w-56 bg-white dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 flex flex-col shrink-0">
      {/* Logo */}
      <div className="h-12 flex items-center px-4 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <span className="font-bold text-sm text-zinc-900 dark:text-white tracking-tight">Bossmode</span>
      </div>

      {/* Sections */}
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
                    const { renameRoom } = await import("../api/client");
                    await renameRoom(id, newName);
                    refresh();
                  } catch (err: any) { toast(err.message, "error"); }
                }}
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

          <SidebarSection
            icon={<BookOpen size={14} />}
            label="Knowledge"
            count={knowledgeBases.length}
            items={kbItems}
            selectedId={selectedKbId}
            storageKey="knowledge"
            defaultOpen={false}
            onSelect={(id) => onNavigate({ type: "knowledge", id })}
            onCreate={() => onNavigate({ type: "knowledge", id: null })}
          />
          {/* Entry sub-tab when viewing an entry */}
          {activePage?.type === "knowledge" && activePage.entryId && (
            <div className="flex items-center gap-1.5 pl-8 pr-3 py-1 group bg-zinc-100 dark:bg-zinc-800/50">
              <span className="text-xs text-zinc-400 dark:text-zinc-500">↳</span>
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate flex-1">{activePage.entryTitle || "Entry"}</span>
              <button
                onClick={() => onNavigate({ type: "knowledge", id: activePage.id! })}
                className="opacity-0 group-hover:opacity-100 text-zinc-400 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer"
              >
                <span className="text-xs">×</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Bottom */}
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
            <button onClick={() => {
              const isDark = document.documentElement.classList.toggle("dark");
              localStorage.setItem("bossmode_theme", isDark ? "dark" : "light");
            }} className="text-zinc-500 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer p-0.5" title="Toggle theme">
              <Sun size={14} className="hidden dark:block" />
              <Moon size={14} className="block dark:hidden" />
            </button>
            <button onClick={onLogout} className="text-zinc-500 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer p-0.5" title="Sign out">
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
