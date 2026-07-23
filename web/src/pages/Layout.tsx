import { useState, useCallback, useRef, useEffect } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { MobileTopBar } from "../components/MobileTopBar";
import { Sheet } from "../components/Sheet";
import {
  type Room,
  type TeamUpdateCandidate,
  type TeamUpdateCheckResult,
  checkTeamUpdates,
  applyTeamUpdates,
  dismissTeamUpdate,
} from "../api/client";
import { Sidebar, type ActivePage } from "../components/Sidebar";
import { TeamsPage } from "./TeamsPage";
import { TeamDetailPage } from "./TeamDetailPage";
import { Main } from "./Main";
import { AgentProfilePage } from "./AgentProfilePage";
import { AgentsPage } from "./AgentsPage";
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
  const [activePage, setActivePage] = useState<ActivePage>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isMobile = useIsMobile();

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

        {/* Teams library (0.19 team layer) */}
        {activePage?.type === "team" && workspaceResourceRouteMode(activePage.name) !== "detail" && (
          <TeamsPage
            onSelectTeam={(name) => setActivePage({ type: "team", name })}
            onRefresh={refreshSidebar}
          />
        )}
        {activePage?.type === "team" && workspaceResourceRouteMode(activePage.name) === "detail" && (
          <TeamDetailPage
            name={activePage.name || ""}
            onBack={() => { setActivePage({ type: "team", name: null }); refreshSidebar(); }}
          />
        )}

        {/* Team prototype v2 (GOO-138): two-section Team page (Agents + Skills); create = dialog over roster */}
        {activePage?.type === "agent" && workspaceResourceRouteMode(activePage.name) !== "detail" && (
          <AgentsPage
            onSelectAgent={(name) => setActivePage({ type: "agent", name })}
            onRefresh={refreshSidebar}
            autoCreate={workspaceResourceRouteMode(activePage.name) === "create"}
            onCloseCreate={() => setActivePage({ type: "agent", name: null })}
            onSelectSkill={(name) => setActivePage({ type: "skill", name })}
            onCreateSkill={() => setActivePage({ type: "skill", name: "__new__" })}
          />
        )}
        {activePage?.type === "agent" && workspaceResourceRouteMode(activePage.name) === "detail" && (
          <AgentProfilePage
            name={activePage.name || ""}
            onBack={() => { setActivePage({ type: "agent", name: null }); refreshSidebar(); }}
            onDeleted={() => { setActivePage({ type: "agent", name: null }); refreshSidebar(); }}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
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
  const [updateCheck, setUpdateCheck] = useState<TeamUpdateCheckResult | null>(null);
  const [dismissedSession, setDismissedSession] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [updateResultNote, setUpdateResultNote] = useState<string | null>(null);

  const refreshUpdateCheck = useCallback(() => {
    checkTeamUpdates().then(setUpdateCheck).catch(console.error);
  }, []);

  useEffect(() => {
    refreshUpdateCheck();
  }, [refreshUpdateCheck]);

  const showBanner = !!(updateCheck?.hasUpdates && !updateCheck.dismissed && !dismissedSession);

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

        {showBanner && updateCheck && (
          <UpdateBanner
            check={updateCheck}
            onReview={() => setShowReview(true)}
            onDismiss={() => setDismissedSession(true)}
            onDismissVersion={async () => {
              await dismissTeamUpdate("version", updateCheck.currentVersion);
              await refreshUpdateCheck();
            }}
            onDismissPermanent={async () => {
              await dismissTeamUpdate("permanent");
              await refreshUpdateCheck();
            }}
            onUpdateAll={async () => {
              const modifiedCount = updateCheck.candidates.filter((c) => c.status === "modified").length;
              if (modifiedCount > 0) {
                const ok = window.confirm(`Update All will overwrite ${modifiedCount} modified built-in file${modifiedCount === 1 ? "" : "s"}. Continue?`);
                if (!ok) return;
              }
              const paths = updateCheck.candidates.map((c) => c.relativePath);
              const result = await applyTeamUpdates(paths);
              setUpdateResultNote(`Updated ${result.applied.length} files.`);
              await refreshUpdateCheck();
            }}
          />
        )}

        {updateResultNote && (
          <div className="mb-3 text-xs text-onair">{updateResultNote}</div>
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

      {showReview && updateCheck && (
        <ReviewDialog
          check={updateCheck}
          onClose={() => setShowReview(false)}
          onApply={async (paths) => {
            const result = await applyTeamUpdates(paths);
            setUpdateResultNote(`Updated ${result.applied.length} selected file${result.applied.length === 1 ? "" : "s"}.`);
            setShowReview(false);
            await refreshUpdateCheck();
          }}
        />
      )}
    </div>
    </div>
  );
}

function buildSummaryText(candidates: TeamUpdateCandidate[]): string {
  const bucket = new Map<string, number>();
  for (const c of candidates) {
    const key = `${c.category}:${c.status}`;
    bucket.set(key, (bucket.get(key) || 0) + 1);
  }
  const parts: string[] = [];
  for (const [k, count] of bucket.entries()) {
    const [category, status] = k.split(":") as [string, string];
    parts.push(`${count} ${category}${count > 1 ? "s" : ""} ${status}`);
  }
  return parts.join(", ");
}

function UpdateBanner({
  check,
  onDismiss,
  onDismissVersion,
  onDismissPermanent,
  onReview,
  onUpdateAll,
}: {
  check: TeamUpdateCheckResult;
  onDismiss: () => void;
  onDismissVersion: () => Promise<void>;
  onDismissPermanent: () => Promise<void>;
  onReview: () => void;
  onUpdateAll: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-accent-dim px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <RefreshCw size={14} className="text-accent-ink shrink-0" />
            <span className="text-sm font-medium text-accent-ink">
              Built-in team update available ({check.installedVersion} → {check.currentVersion})
            </span>
          </div>
          <p className="text-xs text-accent-ink">{buildSummaryText(check.candidates)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onReview} className="text-xs text-accent-ink hover:underline cursor-pointer">Review</button>
          <button onClick={() => void onUpdateAll()} className="text-xs bg-accent text-accent-contrast hover:opacity-90 px-2.5 py-1 rounded cursor-pointer">Update All</button>
          <div className="relative">
            <button onClick={() => setMenuOpen((v) => !v)} className="text-xs text-ink-3 hover:text-ink-2 cursor-pointer">Dismiss ▾</button>
            {menuOpen && (
              <div className="absolute right-0 top-6 z-20 w-48 rounded border border-line bg-surface-3 shadow-lg py-1">
                <button onClick={() => { onDismiss(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 cursor-pointer">Dismiss</button>
                <button onClick={() => { void onDismissVersion(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 cursor-pointer">Skip this version</button>
                <button onClick={() => { void onDismissPermanent(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-2 cursor-pointer">Don't check for updates</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewDialog({
  check,
  onClose,
  onApply,
}: {
  check: TeamUpdateCheckResult;
  onClose: () => void;
  onApply: (paths: string[]) => Promise<void>;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(check.candidates.filter((c) => c.status !== "modified").map((c) => c.relativePath)),
  );

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const groups: Array<{ key: TeamUpdateCandidate["category"]; label: string }> = [
    { key: "agent", label: "Agents" },
    { key: "skill", label: "Skills" },
    { key: "rule", label: "Rules" },
  ];

  return (
    <Sheet open onClose={onClose} size="xl" closeOnOverlayClick={false}>
      <div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-line-soft">
          <h3 className="text-sm font-semibold">Review Updates</h3>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-1 cursor-pointer"><X size={14} /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
          {groups.map((g) => {
            const items = check.candidates.filter((c) => c.category === g.key);
            if (items.length === 0) return null;
            return (
              <div key={g.key}>
                <div className="text-xs font-semibold text-ink-3 uppercase tracking-wider mb-2">{g.label}</div>
                <div className="space-y-2">
                  {items.map((c) => (
                    <label key={c.relativePath} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={selected.has(c.relativePath)} onChange={() => toggle(c.relativePath)} className="cursor-pointer" />
                      <span className="flex-1 truncate">{c.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.status === "new" ? "bg-onair-dim text-onair" : c.status === "updated" ? "bg-accent-dim text-accent-ink" : "bg-think-dim text-think"}`}>{c.status}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line-soft">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-ink-3 hover:text-ink-1 cursor-pointer">Cancel</button>
          <button onClick={() => void onApply([...selected])} className="px-3 py-1.5 text-sm rounded bg-accent text-accent-contrast hover:opacity-90 cursor-pointer">Apply {selected.size} selected</button>
        </div>
      </div>
    </Sheet>
  );
}
