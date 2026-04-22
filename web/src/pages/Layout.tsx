import { useState, useCallback, useRef, useEffect } from "react";
import { Plus } from "lucide-react";
import type { Room } from "../api/client";
import { Sidebar, type ActivePage } from "../components/Sidebar";
import { Main } from "./Main";
import { AgentDetailPage } from "./AgentDetailPage";
import { SkillDetailPage } from "./SkillDetailPage";
import { KnowledgePage } from "./KnowledgePage";
import { MembersPage } from "./MembersPage";
import { SettingsPage } from "./SettingsPage";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";

interface LayoutProps {
  onLogout: () => void;
  username: string;
}

// agent:event types that indicate meaningful content updates (not high-frequency streaming)
const UNREAD_EVENT_TYPES = new Set(["message_end", "agent_end", "user_steer"]);
const SIDEBAR_COLLAPSED_STORAGE_KEY = "bossmode_sidebar_collapsed";

export function Layout({ onLogout, username }: LayoutProps) {
  const [activePage, setActivePage] = useState<ActivePage>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true");

  // Rooms list — shared between Layout (for WS subscriptions) and Sidebar (for rendering)
  const [rooms, setRooms] = useState<Room[]>([]);

  // Unread state
  const [unreadRooms, setUnreadRooms] = useState<Set<string>>(() => new Set());
  const [unreadTabs, setUnreadTabs] = useState<Map<string, Set<string>>>(() => new Map());

  // Track active page + tab in refs for use inside WS callback (avoids stale closures)
  const activePageRef = useRef(activePage);
  activePageRef.current = activePage;
  const activeTabKeyRef = useRef<string>("room");

  const setActiveTabKey = useCallback((key: string) => {
    activeTabKeyRef.current = key;
  }, []);

  const refreshSidebar = useCallback(() => setRefreshKey((k) => k + 1), []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const handleRoomCreated = useCallback((room: Room) => {
    setActivePage({ type: "room", id: room.id });
    refreshSidebar();
  }, [refreshSidebar]);

  // Rooms loaded callback from Sidebar
  const handleRoomsLoaded = useCallback((loadedRooms: Room[]) => {
    setRooms(loadedRooms);
  }, []);

  // WebSocket event handler — drives both useRoom updates and unread state
  const mainWsHandlerRef = useRef<((event: WsEvent) => void) | null>(null);

  const handleWsEvent = useCallback((event: WsEvent) => {
    const page = activePageRef.current;
    const selectedRoomId = page?.type === "room" ? page.id : null;
    const activeTabKey = activeTabKeyRef.current;

    // Forward to Main's useRoom handler
    mainWsHandlerRef.current?.(event);

    if (event.type === "room:message") {
      // F6: Skip user's own messages
      if ((event.message as any)?.sender === "user") return;

      if (event.roomId !== selectedRoomId) {
        // F1: Different room → Sidebar red dot
        setUnreadRooms((prev) => {
          if (prev.has(event.roomId)) return prev;
          const next = new Set(prev);
          next.add(event.roomId);
          return next;
        });
      } else if (activeTabKey !== "room") {
        // F3: Same room but not on room tab → tab red dot on "room"
        setUnreadTabs((prev) => {
          const roomTabs = prev.get(event.roomId) ?? new Set();
          if (roomTabs.has("room")) return prev;
          const next = new Map(prev);
          const nextTabs = new Set(roomTabs);
          nextTabs.add("room");
          next.set(event.roomId, nextTabs);
          return next;
        });
      }
    }

    if (event.type === "agent:event" && event.roomId === selectedRoomId) {
      // Only trigger for meaningful events (PM-approved filter)
      const eventType = (event.event as any)?.type;
      if (!UNREAD_EVENT_TYPES.has(eventType)) return;

      const agentName = event.agent;
      if (activeTabKey !== agentName) {
        // F2: Not viewing this agent → tab red dot
        setUnreadTabs((prev) => {
          const roomTabs = prev.get(event.roomId) ?? new Set();
          if (roomTabs.has(agentName)) return prev;
          const next = new Map(prev);
          const nextTabs = new Set(roomTabs);
          nextTabs.add(agentName);
          next.set(event.roomId, nextTabs);
          return next;
        });
      }
    }
  }, []);

  const { connected, reconnecting, subscribeRoom, unsubscribeRoom } = useWebSocket({
    onEvent: handleWsEvent,
  });

  // Subscribe to ALL rooms for cross-room unread detection
  const subscribedRoomsRef = useRef(new Set<string>());
  useEffect(() => {
    const currentIds = new Set(rooms.map((r) => r.id));
    // Subscribe to new rooms
    for (const id of currentIds) {
      if (!subscribedRoomsRef.current.has(id)) {
        subscribeRoom(id);
      }
    }
    // Unsubscribe from removed rooms
    for (const id of subscribedRoomsRef.current) {
      if (!currentIds.has(id)) {
        unsubscribeRoom(id);
      }
    }
    subscribedRoomsRef.current = currentIds;
  }, [rooms, subscribeRoom, unsubscribeRoom]);

  // F5: Clear Sidebar red dot when switching rooms
  const handleNavigate = useCallback((page: ActivePage) => {
    setActivePage(page);
    if (page?.type === "room") {
      setUnreadRooms((prev) => {
        if (!prev.has(page.id)) return prev;
        const next = new Set(prev);
        next.delete(page.id);
        return next;
      });
    }
  }, []);

  // F4: Clear tab red dot
  const handleClearUnreadTab = useCallback((roomId: string, tabKey: string) => {
    setUnreadTabs((prev) => {
      const roomTabs = prev.get(roomId);
      if (!roomTabs?.has(tabKey)) return prev;
      const next = new Map(prev);
      const nextTabs = new Set(roomTabs);
      nextTabs.delete(tabKey);
      if (nextTabs.size === 0) next.delete(roomId);
      else next.set(roomId, nextTabs);
      return next;
    });
  }, []);

  // Get unread tabs for the selected room
  const selectedRoomId = activePage?.type === "room" ? activePage.id : null;
  const currentRoomUnreadTabs = selectedRoomId ? unreadTabs.get(selectedRoomId) ?? null : null;

  return (
    <div className="h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-white flex" data-1p-ignore>
      <Sidebar
        activePage={activePage}
        username={username}
        onNavigate={handleNavigate}
        onLogout={onLogout}
        refreshKey={refreshKey}
        unreadRoomIds={unreadRooms}
        onRoomsLoaded={handleRoomsLoaded}
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Room view */}
        {activePage?.type === "room" && activePage.id !== "__new__" && (
          <Main
            selectedRoomId={activePage.id}
            onSelectRoom={(id) => handleNavigate({ type: "room", id })}
            onRoomCreated={handleRoomCreated}
            username={username}
            connected={connected}
            reconnecting={reconnecting}
            onRegisterWsHandler={(handler) => { mainWsHandlerRef.current = handler; }}
            unreadTabs={currentRoomUnreadTabs}
            onClearUnreadTab={handleClearUnreadTab}
            onActiveTabKeyChange={setActiveTabKey}
          />
        )}

        {/* Room creation (triggered by sidebar +) */}
        {activePage?.type === "room" && activePage.id === "__new__" && (
          <Main
            selectedRoomId={null}
            onSelectRoom={(id) => handleNavigate({ type: "room", id })}
            onRoomCreated={handleRoomCreated}
            username={username}
            connected={false}
            reconnecting={false}
            onRegisterWsHandler={() => {}}
            unreadTabs={null}
            onClearUnreadTab={() => {}}
            onActiveTabKeyChange={() => {}}
          />
        )}

        {/* Agent detail / create */}
        {activePage?.type === "agent" && activePage.name !== null && (
          <AgentDetailPage
            name={activePage.name}
            onBack={() => { setActivePage({ type: "agent", name: null }); refreshSidebar(); }}
          />
        )}
        {activePage?.type === "agent" && activePage.name === null && (
          <AgentDetailPage
            name=""
            isCreate
            onBack={() => refreshSidebar()}
            onCreated={(name) => { setActivePage({ type: "agent", name }); refreshSidebar(); }}
          />
        )}

        {/* Skill detail / create */}
        {activePage?.type === "skill" && activePage.name !== null && (
          <SkillDetailPage
            name={activePage.name}
            onBack={() => { setActivePage({ type: "skill", name: null }); refreshSidebar(); }}
          />
        )}
        {activePage?.type === "skill" && activePage.name === null && (
          <SkillDetailPage
            name=""
            isCreate
            onBack={() => refreshSidebar()}
            onCreated={(name) => { setActivePage({ type: "skill", name }); refreshSidebar(); }}
          />
        )}

        {/* Knowledge */}
        {activePage?.type === "knowledge" && (
          <KnowledgePage />
        )}

        {/* Members */}
        {activePage?.type === "member" && (
          <MembersPage
            selectedId={activePage.id}
            onSelect={(id) => setActivePage({ type: "member", id })}
            onRefresh={refreshSidebar}
            onNavigateAgent={(name) => setActivePage({ type: "agent", name })}
          />
        )}

        {/* Settings */}
        {activePage?.type === "settings" && <SettingsPage />}

        {/* Home */}
        {!activePage && (
          <HomePage
            rooms={rooms}
            unreadRoomIds={unreadRooms}
            onSelectRoom={(id) => setActivePage({ type: "room", id })}
            onCreateRoom={() => setActivePage({ type: "room", id: "__new__" })}
          />
        )}
      </div>
    </div>
  );
}

interface HomePageProps {
  rooms: Room[];
  unreadRoomIds?: Set<string>;
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
}

function HomePage({ rooms, unreadRoomIds, onSelectRoom, onCreateRoom }: HomePageProps) {
  const hasRooms = rooms.length > 0;

  return (
    <div className="flex-1 flex flex-col items-center overflow-y-auto">
      <div className="w-full max-w-2xl px-6 pt-20 pb-12">
        {hasRooms ? (
          <>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Your Rooms</h1>
            <p className="text-sm text-zinc-500 mb-8">Pick up where you left off, or start something new.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">Get started</h1>
            <p className="text-sm text-zinc-500 mb-8">Create your first room to begin.</p>
          </>
        )}

        <div className="space-y-2">
          {rooms.map((room) => {
            const workingCount = room.agentStatuses
              ? Object.values(room.agentStatuses).filter((s) => s === "working").length
              : 0;

            return (
              <button
                key={room.id}
                onClick={() => onSelectRoom(room.id)}
                className="w-full text-left group rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/50 hover:bg-zinc-100 dark:hover:bg-zinc-900 transition-all px-4 py-3.5 cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 group-hover:text-black dark:group-hover:text-white transition-colors">
                        {room.name}
                      </span>
                      {unreadRoomIds?.has(room.id) && (
                        <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-zinc-500">
                      <span className="font-mono truncate">{room.cwd.split("/").slice(-2).join("/")}</span>
                      <span className="text-zinc-300 dark:text-zinc-700">·</span>
                      <span>{room.members.length} member{room.members.length !== 1 ? "s" : ""}</span>
                    </div>
                  </div>

                  {workingCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5 shrink-0 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse" />
                      {workingCount} working
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          <button
            onClick={onCreateRoom}
            className="w-full text-left group rounded-lg border border-dashed border-zinc-300 dark:border-zinc-800 hover:border-zinc-400 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-900/30 transition-all px-4 py-3.5 cursor-pointer"
          >
            <div className="flex items-center gap-2 text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-300 transition-colors">
              <Plus size={14} />
              <span className="text-sm">New Room</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
