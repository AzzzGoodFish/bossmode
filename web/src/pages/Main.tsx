import { useState, useEffect, useCallback } from "react";
import type { Room, SummarizeStatus } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { MobileTopBar } from "../components/MobileTopBar";
import { Sheet } from "../components/Sheet";
import { Search } from "lucide-react";
import {
  createRoom as apiCreateRoom,
  steerAgent as apiSteerAgent,
  getSummarizeStatus,
  summarizeRoom as apiSummarizeRoom,
  addMember as apiAddMember,
} from "../api/client";
import { useRoom } from "../hooks/useRoom";
import type { WsEvent } from "../hooks/useWebSocket";
import { ChatArea } from "../components/ChatArea";
import { MemberPanel } from "../components/MemberPanel";
import { MessageInput } from "../components/MessageInput";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { AgentTab, type CommittedEvent } from "../components/AgentTab";
import { AddMemberDialog } from "../components/AddMemberDialog";
import { useDialog } from "../components/dialogs";

interface Tab {
  type: "room" | "agent";
  agentName?: string;
}

interface MainProps {
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onRoomCreated: (room: Room) => void;
  username: string;
  externalShowCreateRoom?: boolean;
  onCreateRoomShown?: () => void;
  // WebSocket props (lifted to Layout)
  connected: boolean;
  reconnecting: boolean;
  onRegisterWsHandler: (handler: (event: WsEvent) => void) => void;
  // Unread state
  unreadTabs: Set<string> | null;
  onClearUnreadTab: (roomId: string, tabKey: string) => void;
  onActiveTabKeyChange: (tabKey: string) => void;
  onOpenMobileSidebar?: () => void;
}

export function Main({
  selectedRoomId, onSelectRoom, onRoomCreated, username,
  externalShowCreateRoom, onCreateRoomShown,
  connected, reconnecting, onRegisterWsHandler,
  unreadTabs, onClearUnreadTab, onActiveTabKeyChange,
  onOpenMobileSidebar,
}: MainProps) {
  const { toast } = useDialog();
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const isMobile = useIsMobile();

  useEdgeSwipe({ side: "right", onTrigger: useCallback(() => setMobileMembersOpen(true), []) });

  // Open dialog when triggered from sidebar + button
  useEffect(() => {
    if (externalShowCreateRoom) {
      setShowCreateRoom(true);
      onCreateRoomShown?.();
    }
  }, [externalShowCreateRoom, onCreateRoomShown]);

  const [tabs, setTabs] = useState<Tab[]>(() => {
    if (!selectedRoomId) return [{ type: "room" as const }];
    try {
      const saved = JSON.parse(localStorage.getItem(`bossmode_tabs_${selectedRoomId}`) || "[]") as Tab[];
      return saved.length > 0 ? saved : [{ type: "room" as const }];
    } catch { return [{ type: "room" as const }]; }
  });
  const [activeTabIdx, setActiveTabIdx] = useState(0);
  const [agentEventsCache, setAgentEventsCache] = useState<Record<string, CommittedEvent[]>>({});

  const {
    room,
    messages,
    agentStatus,
    contextUsage,
    loading,
    hasMore,
    loadingOlder,
    loadOlder,
    sendMessage,
    handleWsEvent,
    reloadRoom,
  } = useRoom(selectedRoomId);

  // Register useRoom's WS handler with Layout
  useEffect(() => {
    onRegisterWsHandler(handleWsEvent);
  }, [handleWsEvent, onRegisterWsHandler]);

  // Restore tabs when room changes
  useEffect(() => {
    if (!selectedRoomId) {
      setTabs([{ type: "room" }]);
      setActiveTabIdx(0);
      setAgentEventsCache({});
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(`bossmode_tabs_${selectedRoomId}`) || "[]") as Tab[];
      setTabs(saved.length > 0 ? saved : [{ type: "room" }]);
    } catch { setTabs([{ type: "room" }]); }
    setActiveTabIdx(0);
    setAgentEventsCache({});
  }, [selectedRoomId]);

  // Persist tabs to localStorage
  useEffect(() => {
    if (selectedRoomId) {
      localStorage.setItem(`bossmode_tabs_${selectedRoomId}`, JSON.stringify(tabs));
    }
  }, [tabs, selectedRoomId]);

  // Notify Layout of active tab changes (for unread logic)
  const activeTab = tabs[activeTabIdx];
  useEffect(() => {
    const key = activeTab?.type === "room" ? "room" : activeTab?.agentName ?? "room";
    onActiveTabKeyChange(key);
  }, [activeTab, onActiveTabKeyChange]);

  const handleTabSwitch = useCallback((idx: number) => {
    setActiveTabIdx(idx);
    // F4: Clear unread when switching to a tab
    if (selectedRoomId) {
      const tab = tabs[idx];
      const tabKey = tab?.type === "room" ? "room" : tab?.agentName;
      if (tabKey) onClearUnreadTab(selectedRoomId, tabKey);
    }
  }, [tabs, selectedRoomId, onClearUnreadTab]);

  const openAgentTab = useCallback((agentName: string) => {
    setTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.type === "agent" && t.agentName === agentName);
      if (existingIdx !== -1) {
        handleTabSwitch(existingIdx);
        return prev;
      }
      const newTabs = [...prev, { type: "agent" as const, agentName }];
      handleTabSwitch(newTabs.length - 1);
      return newTabs;
    });
  }, [handleTabSwitch]);

  const closeTab = useCallback((idx: number) => {
    if (idx === 0) return;
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveTabIdx((current) => {
        if (current >= next.length) return next.length - 1;
        if (current > idx) return current - 1;
        return current;
      });
      return next;
    });
  }, []);

  const handleSteer = useCallback(
    async (agentName: string, content: string) => {
      if (!selectedRoomId) return;
      try {
        await apiSteerAgent(selectedRoomId, agentName, content);
      } catch (err: any) {
        console.error("Steer failed:", err);
      }
    },
    [selectedRoomId],
  );

  const handleCreateRoom = useCallback(
    async (name: string, cwd: string, members: string[], ruleDocs?: string[]) => {
      try {
        const newRoom = await apiCreateRoom(name, cwd, members, ruleDocs);
        onRoomCreated(newRoom);
        setShowCreateRoom(false);
      } catch (err: any) {
        toast(err.message, "error");
      }
    },
    [onRoomCreated, toast],
  );

  const handleAgentEventsChange = useCallback((events: CommittedEvent[]) => {
    const tab = tabs[activeTabIdx];
    if (tab?.type === "agent" && tab.agentName) {
      setAgentEventsCache((prev) => ({ ...prev, [tab.agentName!]: events }));
    }
  }, [tabs, activeTabIdx]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [summarizeDialog, setSummarizeDialog] = useState<{ status: SummarizeStatus; totalMessages: number } | null>(null);
  const [summarizeKeepCount, setSummarizeKeepCount] = useState(50);

  const handleSummarize = useCallback(async () => {
    if (!selectedRoomId) return;
    try {
      const status = await getSummarizeStatus(selectedRoomId);
      if (status.isSummarizing) {
        toast("Summarization already in progress.", "info");
        return;
      }
      if (!status.available && status.toSummarize === 0) {
        toast("No messages to summarize.", "info");
        return;
      }
      const total = status.toSummarize + status.toKeep;
      setSummarizeKeepCount(status.toKeep);
      setSummarizeDialog({ status, totalMessages: total });
    } catch (err: any) {
      toast(`Summarize failed: ${err.message}`, "error");
    }
  }, [selectedRoomId, toast]);

  const handleSummarizeConfirm = useCallback(async () => {
    if (!selectedRoomId) return;
    setSummarizeDialog(null);
    try {
      await apiSummarizeRoom(selectedRoomId, summarizeKeepCount);
      toast("Summarization started.", "success");
    } catch (err: any) {
      toast(`Summarize failed: ${err.message}`, "error");
    }
  }, [selectedRoomId, summarizeKeepCount, toast]);

  // Refresh preview when keepCount changes in dialog
  useEffect(() => {
    if (!summarizeDialog || !selectedRoomId) return;
    const total = summarizeDialog.totalMessages;
    const toSummarize = Math.max(0, total - summarizeKeepCount);
    setSummarizeDialog((prev) => prev ? {
      ...prev,
      status: { ...prev.status, toSummarize, toKeep: summarizeKeepCount, available: toSummarize > 0 },
    } : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summarizeKeepCount]);

  // Ctrl/Cmd+F keyboard shortcut for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const handleAddMember = useCallback(async (agentName: string) => {
    if (!selectedRoomId) return;
    try {
      await apiAddMember(selectedRoomId, agentName);
      await reloadRoom();
    } catch (err: any) {
      toast(`Failed to add member: ${err.message}`, "error");
    }
  }, [selectedRoomId, reloadRoom, toast]);

  if (!room) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 text-lg mb-3">No room selected</p>
          <button
            onClick={() => setShowCreateRoom(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            Create a room
          </button>
        </div>

        {showCreateRoom && (
          <CreateRoomDialog
            onClose={() => setShowCreateRoom(false)}
            onSubmit={handleCreateRoom}
          />
        )}
      </div>
    );
  }

  return (
    <>
      {/* Mobile top bar */}
      {room && (
        <MobileTopBar
          title={room.name}
          onOpenSidebar={onOpenMobileSidebar || (() => {})}
          showMembers
          onOpenMembers={() => setMobileMembersOpen(true)}
        />
      )}

      {/* Tab bar */}
      <div className="h-9 border-b border-zinc-200 dark:border-zinc-800 flex items-end px-2 shrink-0 gap-0.5 overflow-x-auto scrollbar-hide">
        {tabs.map((tab, idx) => {
          const isActive = idx === activeTabIdx;
          const label = tab.type === "room" ? `# ${room.name}` : tab.agentName!;
          const tabKey = tab.type === "room" ? "room" : tab.agentName!;
          const hasUnread = !isActive && unreadTabs?.has(tabKey);
          return (
            <button
              key={tab.type === "room" ? "room" : tab.agentName}
              onClick={() => handleTabSwitch(idx)}
              className={`group flex items-center gap-1 px-3 py-1.5 text-xs rounded-t transition-colors cursor-pointer ${
                isActive ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
              }`}
            >
              <span className="truncate max-w-24">{label}</span>
              {hasUnread && <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />}
              {tab.type === "agent" && (
                <span
                  onClick={(e) => { e.stopPropagation(); closeTab(idx); }}
                  className="text-zinc-400 dark:text-zinc-600 hover:text-zinc-700 dark:hover:text-zinc-300 ml-1 cursor-pointer"
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
        <span className="ml-auto mb-2.5 flex items-center gap-1">
          {reconnecting && <span className="text-[10px] text-amber-500 animate-pulse">Reconnecting...</span>}
          {!connected && !reconnecting && <span className="text-[10px] text-red-400">Disconnected</span>}
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${
            connected ? "bg-emerald-500" : reconnecting ? "bg-amber-500 animate-pulse" : "bg-red-400"
          }`} title={connected ? "Connected" : reconnecting ? "Reconnecting" : "Disconnected"} />
        </span>
      </div>

      {/* Room header */}
      {activeTab?.type === "room" && (
        <div className="h-8 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between px-4 shrink-0">
          <span className="text-xs text-zinc-500 dark:text-zinc-600 truncate">{room.cwd}</span>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => setShowAddMember(true)} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer">+ Member</button>
            <button onClick={handleSummarize} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer">Summarize</button>
            <button onClick={() => setSearchOpen((v) => !v)} title="Search messages (Ctrl+F)" className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer">
              <Search size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          {activeTab?.type === "room" ? (
            <>
              <ChatArea messages={messages} roomName={room.name} roomId={room.id} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} members={room.members} />
              <MessageInput onSend={sendMessage} members={room.members} disabled={loading} roomId={selectedRoomId || undefined} />
            </>
          ) : activeTab?.type === "agent" && selectedRoomId ? (
            <AgentTab
              key={`${selectedRoomId}:${activeTab.agentName}`}
              roomId={selectedRoomId}
              agentName={activeTab.agentName!}
              onClose={() => closeTab(activeTabIdx)}
              onSteer={(content) => handleSteer(activeTab.agentName!, content)}
              cachedEvents={agentEventsCache[activeTab.agentName!]}
              onEventsChange={handleAgentEventsChange}
            />
          ) : null}
        </div>

        {/* Member panel */}
        {/* Desktop member panel */}
        <div className="hidden md:block w-48 border-l border-zinc-200 dark:border-zinc-800 shrink-0">
          <MemberPanel
            members={room.members}
            agentStatus={agentStatus}
            contextUsage={contextUsage}
            roomId={room.id}
            onOpenPrivateChat={openAgentTab}
          />
        </div>

        {/* Mobile member drawer */}
        {isMobile && (
          <MobileDrawer open={mobileMembersOpen} side="right" onClose={() => setMobileMembersOpen(false)} width="w-72">
            <MemberPanel
              members={room.members}
              agentStatus={agentStatus}
              contextUsage={contextUsage}
              roomId={room.id}
              onOpenPrivateChat={(name) => { openAgentTab(name); setMobileMembersOpen(false); }}
            />
          </MobileDrawer>
        )}
      </div>

      {showCreateRoom && (
        <CreateRoomDialog onClose={() => setShowCreateRoom(false)} onSubmit={handleCreateRoom} />
      )}
      {showAddMember && (
        <AddMemberDialog currentMembers={room.members} onAdd={handleAddMember} onClose={() => setShowAddMember(false)} />
      )}
      {summarizeDialog && (
        <Sheet open={!!summarizeDialog} onClose={() => setSummarizeDialog(null)} size="sm">
          <div className="p-5">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white mb-3">Summarize Messages</h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-300 mb-4">
              {summarizeKeepCount === 0
                ? `Summarize all ${summarizeDialog.totalMessages} messages into topic summaries.`
                : `Summarize ${summarizeDialog.status.toSummarize} of ${summarizeDialog.totalMessages} messages into topic summaries. Latest ${summarizeKeepCount} will be kept as-is.`}
            </p>
            <div className="mb-4">
              <label className="text-xs text-zinc-500 dark:text-zinc-400 block mb-1.5">Keep latest messages</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={summarizeDialog.totalMessages}
                  value={summarizeKeepCount}
                  onChange={(e) => setSummarizeKeepCount(parseInt(e.target.value))}
                  className="flex-1 accent-violet-500"
                />
                <input
                  type="number"
                  min={0}
                  max={summarizeDialog.totalMessages}
                  value={summarizeKeepCount}
                  onChange={(e) => setSummarizeKeepCount(Math.min(summarizeDialog.totalMessages, Math.max(0, parseInt(e.target.value) || 0)))}
                  className="w-16 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 text-sm text-zinc-900 dark:text-white text-center"
                />
              </div>
              {summarizeKeepCount === 0 && (
                <p className="text-xs text-amber-500 dark:text-amber-400 mt-1.5">All messages will be summarized — agents will lose raw context.</p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setSummarizeDialog(null)}
                className="px-4 py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer transition-colors">
                Cancel
              </button>
              <button onClick={handleSummarizeConfirm} disabled={summarizeDialog.status.toSummarize === 0}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500 text-white text-sm font-medium rounded-lg cursor-pointer transition-colors">
                Summarize
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
