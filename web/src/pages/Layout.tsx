import { useState, useCallback, useRef, useEffect } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import {
  type Room,
  type TeamUpdateCandidate,
  type TeamUpdateCheckResult,
  checkTeamUpdates,
  applyTeamUpdates,
  dismissTeamUpdate,
} from "../api/client";
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
          <KnowledgePage initialPath={activePage.path} />
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
              const paths = updateCheck.candidates.filter((c) => c.status !== "modified").map((c) => c.relativePath);
              const result = await applyTeamUpdates(paths);
              const skippedModified = updateCheck.candidates.filter((c) => c.status === "modified").length;
              setUpdateResultNote(
                skippedModified > 0
                  ? `Updated ${result.applied.length} files. Skipped ${skippedModified} modified file${skippedModified === 1 ? "" : "s"} (use Review to update individually).`
                  : `Updated ${result.applied.length} files.`,
              );
              await refreshUpdateCheck();
            }}
          />
        )}

        {updateResultNote && (
          <div className="mb-3 text-xs text-emerald-600 dark:text-emerald-400">{updateResultNote}</div>
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
    <div className="mb-4 rounded-lg border border-blue-200 dark:border-blue-800/50 bg-blue-50 dark:bg-blue-950/30 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <RefreshCw size={14} className="text-blue-500 shrink-0" />
            <span className="text-sm font-medium text-blue-800 dark:text-blue-300">
              Built-in team update available ({check.installedVersion} → {check.currentVersion})
            </span>
          </div>
          <p className="text-xs text-blue-600 dark:text-blue-400">{buildSummaryText(check.candidates)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onReview} className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer">Review</button>
          <button onClick={() => void onUpdateAll()} className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-2.5 py-1 rounded cursor-pointer">Update All</button>
          <div className="relative">
            <button onClick={() => setMenuOpen((v) => !v)} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer">Dismiss ▾</button>
            {menuOpen && (
              <div className="absolute right-0 top-6 z-20 w-48 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg py-1">
                <button onClick={() => { onDismiss(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer">Dismiss</button>
                <button onClick={() => { void onDismissVersion(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer">Skip this version</button>
                <button onClick={() => { void onDismissPermanent(); setMenuOpen(false); }} className="w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 cursor-pointer">Don't check for updates</button>
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
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">Review Updates</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer"><X size={14} /></button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-4">
          {groups.map((g) => {
            const items = check.candidates.filter((c) => c.category === g.key);
            if (items.length === 0) return null;
            return (
              <div key={g.key}>
                <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">{g.label}</div>
                <div className="space-y-2">
                  {items.map((c) => (
                    <label key={c.relativePath} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={selected.has(c.relativePath)} onChange={() => toggle(c.relativePath)} className="cursor-pointer" />
                      <span className="flex-1 truncate">{c.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${c.status === "new" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400" : c.status === "updated" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400" : "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400"}`}>{c.status}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer">Cancel</button>
          <button onClick={() => void onApply([...selected])} className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white cursor-pointer">Apply {selected.size} selected</button>
        </div>
      </div>
    </div>
  );
}
