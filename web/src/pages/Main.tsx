import { useState, useEffect, useCallback } from "react";
import type { Room, SummarizeStatus } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { MobileTopBar } from "../components/MobileTopBar";
import { Sheet } from "../components/Sheet";
import { Search, Plus, ScrollText, Maximize2, Minimize2, X } from "lucide-react";
import { TasksTab } from "./TasksTab";
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
import { StationPanel } from "../components/StationPanel";
import { MessageInput } from "../components/MessageInput";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { AgentTab, type CommittedEvent } from "../components/AgentTab";
import { AddMemberDialog } from "../components/AddMemberDialog";
import { useDialog } from "../components/dialogs";

interface MainProps {
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onRoomCreated: (room: Room) => void;
  username: string;
  externalShowCreateRoom?: boolean;
  onCreateRoomShown?: () => void;
  connected: boolean;
  reconnecting: boolean;
  onRegisterWsHandler: (handler: (event: WsEvent) => void) => void;
  unreadTabs: Set<string> | null;
  onClearUnreadTab: (roomId: string, tabKey: string) => void;
  onActiveTabKeyChange: (tabKey: string) => void;
  onOpenMobileSidebar?: () => void;
  onNavigateToTask?: (roomId: string, taskId: string, from?: string) => void;
}

type RoomView = "chat" | "tasks";

export function Main({
  selectedRoomId, onSelectRoom, onRoomCreated, username,
  externalShowCreateRoom, onCreateRoomShown,
  connected, reconnecting, onRegisterWsHandler,
  unreadTabs, onClearUnreadTab, onActiveTabKeyChange,
  onOpenMobileSidebar,
  onNavigateToTask,
}: MainProps) {
  const { toast } = useDialog();
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const isMobile = useIsMobile();

  useEdgeSwipe({ side: "right", onTrigger: useCallback(() => setMobileMembersOpen(true), []) });

  useEffect(() => {
    if (externalShowCreateRoom) {
      setShowCreateRoom(true);
      onCreateRoomShown?.();
    }
  }, [externalShowCreateRoom, onCreateRoomShown]);

  // 视图：Chat | Tasks；镜头：lensAgent（分屏）+ lensExpanded（全幅工位视图）
  const [view, setView] = useState<RoomView>("chat");
  const [lensAgent, setLensAgent] = useState<string | null>(null);
  const [lensExpanded, setLensExpanded] = useState(false);
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
    jumpToMessage,
    returnToLatest,
    inHistoryView,
  } = useRoom(selectedRoomId);

  useEffect(() => {
    onRegisterWsHandler(handleWsEvent);
  }, [handleWsEvent, onRegisterWsHandler]);

  // 房间切换时重置视图
  useEffect(() => {
    setLensExpanded(false);
    setAgentEventsCache({});
    const restoreTab = sessionStorage.getItem("bossmode_main_restore_tab");
    sessionStorage.removeItem("bossmode_main_restore_tab");
    setView(restoreTab === "tasks" ? "tasks" : "chat");
    // 从 Team 页 "Lens" 跳转过来时直接打开对应工位镜头
    const openLensAgent = sessionStorage.getItem("bossmode_main_open_lens");
    sessionStorage.removeItem("bossmode_main_open_lens");
    setLensAgent(openLensAgent || null);
  }, [selectedRoomId]);

  // 通知 Layout 当前关注的 tab key（unread 逻辑）
  useEffect(() => {
    const key = lensAgent ?? (view === "chat" ? "room" : "tasks");
    onActiveTabKeyChange(key);
  }, [view, lensAgent, onActiveTabKeyChange]);

  const openLens = useCallback((agentName: string) => {
    setLensAgent(agentName);
    if (isMobile) setLensExpanded(true);
    setMobileMembersOpen(false);
    if (selectedRoomId) onClearUnreadTab(selectedRoomId, agentName);
  }, [isMobile, selectedRoomId, onClearUnreadTab]);

  const closeLens = useCallback(() => {
    setLensAgent(null);
    setLensExpanded(false);
    if (selectedRoomId) onClearUnreadTab(selectedRoomId, "room");
  }, [selectedRoomId, onClearUnreadTab]);

  const switchView = useCallback((v: RoomView) => {
    setView(v);
    if (selectedRoomId) onClearUnreadTab(selectedRoomId, v === "chat" ? "room" : "tasks");
  }, [selectedRoomId, onClearUnreadTab]);

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
    if (lensAgent) {
      setAgentEventsCache((prev) => ({ ...prev, [lensAgent]: events }));
    }
  }, [lensAgent]);

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
      <div className="flex-1 flex items-center justify-center bg-surface-1">
        <div className="text-center">
          <p className="text-ink-3 text-lg mb-3">No room selected</p>
          <button
            onClick={() => setShowCreateRoom(true)}
            className="px-4 py-2 bg-accent text-accent-contrast text-sm font-semibold rounded-md transition-opacity hover:opacity-90 cursor-pointer"
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

  const segBtn = (active: boolean) =>
    `px-3.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
      active ? "bg-surface-3 text-ink-1" : "text-ink-3 hover:text-ink-2"
    }`;
  const toolBtn = "w-7 h-7 flex items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 transition-colors cursor-pointer";

  const lensFull = lensAgent && (lensExpanded || isMobile);
  const lensSplit = lensAgent && !lensFull;

  const lensPanel = lensAgent && (
    <div className={`flex flex-col min-h-0 min-w-0 bg-surface-1 ${lensFull ? "flex-1" : "w-[440px] shrink-0 border-l border-line"}`}>
      {/* lens 头部：工位标识 + 展开/收起 + 关闭 */}
      <div className="h-9 shrink-0 border-b border-line-soft flex items-center gap-2 px-3 bg-surface-0">
        <span className="text-[10px] font-semibold tracking-[0.06em] text-accent-ink">WORKSTATION</span>
        <span className="text-xs font-semibold text-ink-1">{lensAgent}</span>
        <span className="flex-1" />
        {!isMobile && (
          <button
            onClick={() => setLensExpanded((v) => !v)}
            className={toolBtn}
            title={lensExpanded ? "收起为分屏镜头" : "打开完整工位视图"}
          >
            {lensExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
        <button onClick={closeLens} className={toolBtn} title="关闭镜头">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <AgentTab
          key={`${selectedRoomId}:${lensAgent}`}
          roomId={selectedRoomId!}
          agentName={lensAgent}
          onClose={closeLens}
          onSteer={(content) => handleSteer(lensAgent, content)}
          cachedEvents={agentEventsCache[lensAgent]}
          onEventsChange={handleAgentEventsChange}
        />
      </div>
    </div>
  );

  return (
    <>
      {room && (
        <MobileTopBar
          title={room.name}
          onOpenSidebar={onOpenMobileSidebar || (() => {})}
          showMembers
          onOpenMembers={() => setMobileMembersOpen(true)}
        />
      )}

      {/* 台口：房间名 + cwd + rule + segmented + 工具组 */}
      <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-ink-1 whitespace-nowrap">{room.name}</h2>
          <span className="font-mono text-[11px] text-ink-4 truncate hidden sm:block">{room.cwd}</span>
          {(room.ruleDocs?.length ?? 0) > 0 && (
            <span className="text-[10px] px-2 py-px rounded-full border border-line text-ink-3 whitespace-nowrap hidden md:block">
              rule · {room.ruleDocs!.length}
            </span>
          )}
        </div>

        <div className="flex bg-inset border border-line-soft rounded-lg p-0.5 shrink-0">
          <button onClick={() => switchView("chat")} className={segBtn(view === "chat" && !lensFull)}>
            Chat
            {unreadTabs?.has("room") && view !== "chat" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1.5 align-middle" />}
          </button>
          <button onClick={() => switchView("tasks")} className={segBtn(view === "tasks" && !lensFull)}>
            Tasks
          </button>
        </div>

        <div className="ml-auto flex items-center gap-1 shrink-0">
          <span className="flex items-center gap-1.5 mr-1.5" title={connected ? "Connected" : reconnecting ? "Reconnecting" : "Disconnected"}>
            {reconnecting && <span className="text-[10px] text-think animate-pulse hidden sm:block">reconnecting</span>}
            {!connected && !reconnecting && <span className="text-[10px] text-blocked hidden sm:block">offline</span>}
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${
              connected ? "bg-onair" : reconnecting ? "bg-think animate-pulse" : "bg-blocked"
            }`} />
            {connected && <span className="text-[10px] text-ink-4 hidden sm:block">live</span>}
          </span>
          <button onClick={() => setShowAddMember(true)} className={toolBtn} title="Add member">
            <Plus size={14} />
          </button>
          <button onClick={handleSummarize} className={toolBtn} title="Summarize messages">
            <ScrollText size={13} />
          </button>
          <button onClick={() => setSearchOpen((v) => !v)} className={toolBtn} title="Search messages (Ctrl+F)">
            <Search size={13} />
          </button>
        </div>
      </div>

      {/* 内容区：chat/tasks + lens 分屏 + 工位墙 */}
      <div className="flex-1 flex min-h-0 bg-surface-1">
        {!lensFull && (
          <div className="flex-1 flex flex-col min-w-0">
            {view === "chat" ? (
              <>
                <ChatArea messages={messages} roomName={room.name} roomId={room.id} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} members={room.members} onNavigateToTask={selectedRoomId ? (taskId) => onNavigateToTask?.(selectedRoomId, taskId, "chat") : undefined} onJumpToMessage={jumpToMessage} onReturnToLatest={returnToLatest} inHistoryView={inHistoryView} />
                <MessageInput onSend={sendMessage} members={room.members} disabled={loading} roomId={selectedRoomId || undefined} onError={(msg) => toast(msg, "error")} />
              </>
            ) : selectedRoomId ? (
              <TasksTab
                roomId={selectedRoomId}
                members={room.members}
                onOpenTaskDetail={(taskId) => onNavigateToTask?.(selectedRoomId, taskId, "tasks")}
              />
            ) : null}
          </div>
        )}

        {/* lens（分屏或全幅） */}
        {lensPanel}

        {/* 工位墙（桌面） */}
        <div className={`hidden ${lensSplit ? "xl:block" : "md:block"} w-[280px] border-l border-line shrink-0`}>
          <StationPanel
            members={room.members}
            agentStatus={agentStatus}
            contextUsage={contextUsage}
            roomId={room.id}
            onOpenLens={openLens}
            unreadAgents={unreadTabs}
          />
        </div>

        {/* 工位墙（移动端抽屉） */}
        {isMobile && (
          <MobileDrawer open={mobileMembersOpen} side="right" onClose={() => setMobileMembersOpen(false)} width="w-80">
            <StationPanel
              members={room.members}
              agentStatus={agentStatus}
              contextUsage={contextUsage}
              roomId={room.id}
              onOpenLens={openLens}
              unreadAgents={unreadTabs}
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
            <h3 className="text-sm font-semibold text-ink-1 mb-3">Summarize Messages</h3>
            <p className="text-sm text-ink-2 mb-4">
              {summarizeKeepCount === 0
                ? `Summarize all ${summarizeDialog.totalMessages} messages into topic summaries.`
                : `Summarize ${summarizeDialog.status.toSummarize} of ${summarizeDialog.totalMessages} messages into topic summaries. Latest ${summarizeKeepCount} will be kept as-is.`}
            </p>
            <div className="mb-4">
              <label className="text-xs text-ink-3 block mb-1.5">Keep latest messages</label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={summarizeDialog.totalMessages}
                  value={summarizeKeepCount}
                  onChange={(e) => setSummarizeKeepCount(parseInt(e.target.value))}
                  className="flex-1 accent-(--accent)"
                />
                <input
                  type="number"
                  min={0}
                  max={summarizeDialog.totalMessages}
                  value={summarizeKeepCount}
                  onChange={(e) => setSummarizeKeepCount(Math.min(summarizeDialog.totalMessages, Math.max(0, parseInt(e.target.value) || 0)))}
                  className="w-16 bg-inset border border-line rounded px-2 py-1 text-sm text-ink-1 text-center"
                />
              </div>
              {summarizeKeepCount === 0 && (
                <p className="text-xs text-think mt-1.5">All messages will be summarized — agents will lose raw context.</p>
              )}
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setSummarizeDialog(null)}
                className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer transition-colors">
                Cancel
              </button>
              <button onClick={handleSummarizeConfirm} disabled={summarizeDialog.status.toSummarize === 0}
                className="px-4 py-2 bg-accent text-accent-contrast disabled:opacity-40 text-sm font-semibold rounded-md cursor-pointer transition-opacity hover:opacity-90">
                Summarize
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
