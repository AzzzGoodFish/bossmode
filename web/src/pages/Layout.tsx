import { useState, useCallback, useRef, useEffect } from "react";
import { Plus } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { MobileTopBar } from "../components/MobileTopBar";
import {
  type Room,
} from "../api/client";
import { Sidebar, type ActivePage } from "../components/Sidebar";
import { OnboardingTour } from "../components/OnboardingTour";
import { clearOnboardingDone, isOnboardingDone } from "../onboarding/storage";
import { ContactsPage } from "./ContactsPage";
import { DmPage } from "./DmPage";
import { ChatsPage } from "./ChatsPage";
import { MemberCreatePage } from "./MemberCreatePage";
import { MemberSettingsPage } from "./MemberSettingsPage";
import { TemplatesPage } from "./TemplatesPage";
import { Main } from "./Main";
import { TopicPage } from "./TopicPage";
import { createTopic } from "../api/client";
import { useDialog } from "../components/dialogs";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsPage } from "./SkillsPage";
import { KnowledgePage } from "./KnowledgePage";
import { SettingsPage } from "./SettingsPage";
import { AllTasksPage } from "./AllTasksPage";
import { TaskDetailPage } from "./TaskDetailPage";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";

interface LayoutProps {
  onLogout: () => void;
  username: string;
}

// agent:event types that indicate meaningful content updates (not high-frequency streaming)
const UNREAD_EVENT_TYPES = new Set(["message_end", "agent_end", "user_steer"]);
const SIDEBAR_COLLAPSED_STORAGE_KEY = "bossmode_sidebar_collapsed";

export function workspaceResourceRouteMode(name: string | null): "list" | "create" | "detail" {
  if (name === null) return "list";
  if (name === "__new__") return "create";
  return "detail";
}

export function patchRoomAgentStatus(rooms: Room[], roomId: string, agent: string, status: string): Room[] {
  let changed = false;
  const next = rooms.map((room) => {
    if (room.id !== roomId) return room;
    if (room.agentStatuses?.[agent] === status) return room;
    changed = true;
    return {
      ...room,
      agentStatuses: {
        ...(room.agentStatuses ?? {}),
        [agent]: status,
      },
    };
  });
  return changed ? next : rooms;
}

export function Layout({ onLogout, username }: LayoutProps) {
  const { toast } = useDialog();
  const [activePage, setActivePage] = useState<ActivePage>({ type: "chats" });
  /** Cross-page jump target: topic anchor block → room stream message (topic-threads v2). */
  const [pendingJump, setPendingJump] = useState<{ roomId: string; messageId: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const isMobile = useIsMobile();

  // First-launch product tour (once unless finished/skipped; Help can replay).
  useEffect(() => {
    if (isOnboardingDone()) return;
    const t = window.setTimeout(() => setTourOpen(true), 600);
    return () => window.clearTimeout(t);
  }, []);

  const startTour = useCallback(() => {
    clearOnboardingDone();
    setTourOpen(true);
  }, []);

  const ensureSidebarOpen = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen(true);
      return;
    }
    setSidebarCollapsed((prev) => {
      if (!prev) return prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "false");
      return false;
    });
  }, [isMobile]);

  useEdgeSwipe({ side: "left", onTrigger: useCallback(() => setMobileSidebarOpen(true), []) });

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

    if (event.type === "agent:status") {
      setRooms((prev) => patchRoomAgentStatus(prev, event.roomId, event.agent, event.status));
    }

    if (event.type === "room:message") {
      // Skip messages that never badge: user's own, system notices, typed task/knowledge events
      // (same eligibility as the chats-list unread count, fish 2026-08-04).
      const msg = event.message as { sender?: string; type?: string } | undefined;
      if (!msg || msg.sender === "user" || msg.sender === "system") return;
      if (msg.type === "task_event" || msg.type === "knowledge_event") return;

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

  const sidebarEl = (
    <Sidebar
      activePage={activePage}
      username={username}
      onNavigate={(p) => { handleNavigate(p); if (isMobile) setMobileSidebarOpen(false); }}
      onLogout={onLogout}
      refreshKey={refreshKey}
      unreadRoomIds={unreadRooms}
      onRoomsLoaded={handleRoomsLoaded}
      liveRooms={rooms}
      collapsed={isMobile ? false : sidebarCollapsed}
      onToggle={toggleSidebar}
      onReplayTour={startTour}
    />
  );

  return (
    <div className="fixed inset-x-0 top-0 h-[100dvh] bg-surface-0 text-ink-1 flex" data-1p-ignore>
      {/* Desktop sidebar */}
      <div className="hidden md:flex">{sidebarEl}</div>

      {/* Mobile sidebar drawer */}
      {isMobile && (
        <MobileDrawer open={mobileSidebarOpen} side="left" onClose={() => setMobileSidebarOpen(false)} width="w-72">
          {sidebarEl}
        </MobileDrawer>
      )}

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Room view */}
        {activePage?.type === "room" && activePage.id !== "__new__" && (
          <Main
            selectedRoomId={activePage.id}
            onSelectRoom={(id) => handleNavigate({ type: "room", id })}
            onRoomCreated={handleRoomCreated}
            onRoomDeleted={(roomId) => {
              refreshSidebar();
              if (activePageRef.current?.type === "room" && activePageRef.current.id === roomId) handleNavigate(null);
            }}
            username={username}
            connected={connected}
            reconnecting={reconnecting}
            onRegisterWsHandler={(handler) => { mainWsHandlerRef.current = handler; }}
            unreadTabs={currentRoomUnreadTabs}
            onClearUnreadTab={handleClearUnreadTab}
            onActiveTabKeyChange={setActiveTabKey}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            onNavigateToTask={(roomId, taskId, from) => setActivePage({ type: "task", roomId, taskId, from: (from as "chat" | "tasks" | "all-tasks") || "chat" })}
            onNavigateToKnowledge={(path) => setActivePage({ type: "knowledge", path })}
            onOpenMcpSettings={() => setActivePage({ type: "settings", section: "integrations" })}
            onOpenExtensionsSettings={() => setActivePage({ type: "settings", section: "extensions" })}
            onOpenTopicPage={(roomId, topicId) => handleNavigate({ type: "topic", roomId, topicId })}
            onOpenTopicDraft={(roomId, anchor) => handleNavigate({ type: "topic-draft", roomId, anchorMessageId: anchor.anchorMessageId, anchorSeq: anchor.anchorSeq, anchorTitle: anchor.title, anchorExcerpt: anchor.excerpt })}
            pendingJump={pendingJump}
            onConsumeJump={() => setPendingJump(null)}
          />
        )}

        {/* Topic workspace (topic-threads v2): room-form page, back returns to the room */}
        {activePage?.type === "topic" && (
          <TopicPage
            roomId={activePage.roomId}
            topicId={activePage.topicId}
            onBack={() => handleNavigate({ type: "room", id: activePage.roomId })}
            onJumpToRoomMessage={(messageId) => {
              setPendingJump({ roomId: activePage.roomId, messageId });
              handleNavigate({ type: "room", id: activePage.roomId });
            }}
            onOpenMcpSettings={() => setActivePage({ type: "settings", section: "integrations" })}
            onOpenExtensionsSettings={() => setActivePage({ type: "settings", section: "extensions" })}
          />
        )}

        {/* Topic draft (v3): unsent workspace — the first message creates the topic */}
        {activePage?.type === "topic-draft" && (
          <TopicPage
            roomId={activePage.roomId}
            topicId={null}
            draft={{
              anchorMessageId: activePage.anchorMessageId,
              anchorSeq: activePage.anchorSeq,
              title: activePage.anchorTitle,
              excerpt: activePage.anchorExcerpt,
            }}
            onCreateDraft={async (content) => {
              const page = activePageRef.current;
              if (page?.type !== "topic-draft") return;
              const res = await createTopic(page.roomId, {
                anchorMessageId: page.anchorMessageId,
                content,
                title: page.anchorTitle,
              }).catch((e) => {
                toast(e instanceof Error ? e.message : "Failed to create topic", "error");
                throw e;
              });
              handleNavigate({ type: "topic", roomId: page.roomId, topicId: res.topic.id });
            }}
            onBack={() => handleNavigate({ type: "room", id: activePage.roomId })}
            onJumpToRoomMessage={(messageId) => {
              setPendingJump({ roomId: activePage.roomId, messageId });
              handleNavigate({ type: "room", id: activePage.roomId });
            }}
            onOpenMcpSettings={() => setActivePage({ type: "settings", section: "integrations" })}
            onOpenExtensionsSettings={() => setActivePage({ type: "settings", section: "extensions" })}
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
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />
        )}

        {activePage?.type === "chats" && (
          <ChatsPage
            onOpenDm={(memberId) => handleNavigate({ type: "dm", memberId })}
            onOpenRoom={(roomId) => handleNavigate({ type: "room", id: roomId })}
          />
        )}
        {activePage?.type === "contacts" && (
          <ContactsPage
            onOpenDm={(memberId) => handleNavigate({ type: "dm", memberId })}
            onCreateMember={() => handleNavigate({ type: "member-create" })}
          />
        )}
        {activePage?.type === "member-create" && (
          <MemberCreatePage
            onBack={() => handleNavigate({ type: "contacts" })}
            onCreated={(memberId) => handleNavigate({ type: "dm", memberId })}
          />
        )}
        {activePage?.type === "dm" && (
          <DmPage
            memberId={activePage.memberId}
            onBack={() => handleNavigate({ type: "contacts" })}
            onOpenSettings={(memberId) => handleNavigate({ type: "member-settings", memberId })}
            onOpenMcpSettings={() => setActivePage({ type: "settings", section: "integrations" })}
            onOpenExtensionsSettings={() => setActivePage({ type: "settings", section: "extensions" })}
          />
        )}
        {activePage?.type === "member-settings" && (
          <MemberSettingsPage
            memberId={activePage.memberId}
            onBack={() => handleNavigate({ type: "dm", memberId: activePage.memberId })}
            onFired={() => handleNavigate({ type: "contacts" })}
          />
        )}
        {activePage?.type === "templates" && (
          <TemplatesPage
            selected={activePage.name}
            startCreating={activePage.create}
            onSelect={(name) => handleNavigate(name ? { type: "templates", name } : { type: "templates" })}
          />
        )}

        {/* Skill list / detail / create */}
        {activePage?.type === "skill" && workspaceResourceRouteMode(activePage.name) === "list" && (
          <SkillsPage onSelectSkill={(name) => setActivePage({ type: "skill", name })} />
        )}
        {activePage?.type === "skill" && workspaceResourceRouteMode(activePage.name) === "create" && (
          <SkillDetailPage
            name=""
            isCreate
            onBack={() => { setActivePage({ type: "skill", name: null }); refreshSidebar(); }}
            onCreated={(name) => { setActivePage({ type: "skill", name }); refreshSidebar(); }}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />
        )}
        {activePage?.type === "skill" && workspaceResourceRouteMode(activePage.name) === "detail" && (
          <SkillDetailPage
            name={activePage.name || ""}
            onBack={() => { setActivePage({ type: "skill", name: null }); refreshSidebar(); }}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />
        )}

        {/* Knowledge */}
        {activePage?.type === "knowledge" && (
          <KnowledgePage initialPath={activePage.path} onOpenMobileSidebar={() => setMobileSidebarOpen(true)} />
        )}

        {/* Settings */}
        {activePage?.type === "settings" && (
          <SettingsPage section={activePage.section ?? "models"} onOpenMobileSidebar={() => setMobileSidebarOpen(true)} />
        )}
        {activePage?.type === "all-tasks" && (
          <AllTasksPage
            onSelectTask={(roomId, taskId) => setActivePage({ type: "task", roomId, taskId, from: "all-tasks" })}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />
        )}
        {activePage?.type === "task" && (
          <TaskDetailPage
            roomId={activePage.roomId}
            taskId={activePage.taskId}
            onBack={() => {
              const from = activePage.type === "task" ? activePage.from : undefined;
              if (from === "all-tasks") {
                setActivePage({ type: "all-tasks" });
              } else {
                sessionStorage.setItem("bossmode_main_restore_tab", from === "chat" ? "room" : "tasks");
                setActivePage({ type: "room", id: activePage.roomId });
              }
            }}
          />
        )}

        {/* Home */}
        {!activePage && (
          <HomePage
            rooms={rooms}
            unreadRoomIds={unreadRooms}
            onSelectRoom={(id) => setActivePage({ type: "room", id })}
            onCreateRoom={() => setActivePage({ type: "room", id: "__new__" })}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          />
        )}
      </div>

      <OnboardingTour
        open={tourOpen}
        roomIds={rooms.map((r) => r.id)}
        onNavigate={handleNavigate}
        ensureSidebarOpen={ensureSidebarOpen}
        onClose={() => setTourOpen(false)}
      />
    </div>
  );
}

interface HomePageProps {
  rooms: Room[];
  unreadRoomIds?: Set<string>;
  onSelectRoom: (id: string) => void;
  onCreateRoom: () => void;
  onOpenMobileSidebar?: () => void;
}

function HomePage({ rooms, unreadRoomIds, onSelectRoom, onCreateRoom, onOpenMobileSidebar }: HomePageProps) {
  const hasRooms = rooms.length > 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title="Home" onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col items-center overflow-y-auto">
      <div className="w-full max-w-2xl px-6 pt-20 pb-12">
        {hasRooms ? (
          <>
            <h1 className="text-2xl font-semibold text-ink-1 mb-1">Your Rooms</h1>
            <p className="text-sm text-ink-3 mb-8">Pick up where you left off, or start something new.</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-ink-1 mb-1">Get started</h1>
            <p className="text-sm text-ink-3 mb-8">Create your first room to begin.</p>
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
                className="w-full text-left group rounded-lg border border-line-soft hover:border-line-strong bg-surface-0/40 hover:bg-surface-1 transition-all px-4 py-3.5 cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-ink-1 group-hover:text-ink-1 transition-colors">
                        {room.name}
                      </span>
                      {unreadRoomIds?.has(room.id) && (
                        <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-ink-3">
                      <span className="font-mono truncate">{room.cwd.split("/").slice(-2).join("/")}</span>
                      <span className="text-ink-2">·</span>
                      <span>{room.members.length} member{room.members.length !== 1 ? "s" : ""}</span>
                    </div>
                  </div>

                  {workingCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-onair bg-onair/10 border border-onair/20 rounded px-1.5 py-0.5 shrink-0 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-onair animate-pulse" />
                      {workingCount} working
                    </span>
                  )}
                </div>
              </button>
            );
          })}

          <button
            onClick={onCreateRoom}
            className="w-full text-left group rounded-lg border border-dashed border-line hover:border-line-strong hover:bg-surface-1/30 transition-all px-4 py-3.5 cursor-pointer"
          >
            <div className="flex items-center gap-2 text-ink-4 group-hover:text-ink-3 transition-colors">
              <Plus size={14} />
              <span className="text-sm">New Room</span>
            </div>
          </button>
        </div>
      </div>
    </div>
    </div>
  );
}
