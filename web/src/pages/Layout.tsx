import { useState, useCallback, useRef, useEffect } from "react";
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

export function Layout({ onLogout, username }: LayoutProps) {
  const [activePage, setActivePage] = useState<ActivePage>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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
          <KnowledgePage
            selectedKbId={activePage.id}
            selectedEntryId={(activePage as any).entryId}
            onSelectKb={(id) => setActivePage({ type: "knowledge", id })}
            onSelectEntry={(kbId, entryId, entryTitle) => setActivePage({ type: "knowledge", id: kbId, entryId, entryTitle } as any)}
          />
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

        {/* Empty state */}
        {!activePage && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-zinc-400 dark:text-zinc-500 text-lg">Welcome to Bossmode</p>
              <p className="text-zinc-400 dark:text-zinc-600 text-sm mt-1">Select an item from the sidebar</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
