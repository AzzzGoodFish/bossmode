import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { Room, SummarizeStatus, MemberInfo } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { MobileTopBar } from "../components/MobileTopBar";
import { Sheet } from "../components/Sheet";
import { Search, Plus, ScrollText, Settings, X } from "lucide-react";
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
import { ArtifactPreviewPanel, type MessageArtifactPreviewState, type ChatAttachmentPreviewState } from "../components/ArtifactPreviewPanel";
import { PreviewSurface, previewSurfaceStateFrom } from "../components/PreviewSurface";
import { TaskPreviewSurface, TaskPreviewPanel } from "../components/TaskPreviewSurface";
import { StationPanel } from "../components/StationPanel";
import { MessageInput } from "../components/MessageInput";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { AddMemberDialog } from "../components/AddMemberDialog";
import { RoomSettingsDialog } from "../components/RoomSettingsDialog";
import { useDialog } from "../components/dialogs";
import { clampPreviewPct, formatPreviewPct, PREVIEW_PCT_STORAGE_KEY, readPreviewPct } from "../utils/preview-pane-sizing";
import { userActionError } from "../utils/user-error";

interface MainProps {
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onRoomCreated: (room: Room) => void;
  onRoomDeleted?: (roomId: string) => void;
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
  onNavigateToKnowledge?: (path: string) => void;
  onOpenMcpSettings?: () => void;
}

type RoomView = "chat" | "tasks";

function displayAgentHint(agentName: string): string {
  if (!agentName) return "Agent";
  const normalized = agentName.trim();
  const upper = normalized.toUpperCase();
  if (["QA", "PM"].includes(upper)) return upper;
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const acronym = part.toUpperCase();
      if (["QA", "PM"].includes(acronym)) return acronym;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function Main({
  selectedRoomId, onSelectRoom, onRoomCreated, onRoomDeleted, username,
  externalShowCreateRoom, onCreateRoomShown,
  connected, reconnecting, onRegisterWsHandler,
  unreadTabs, onClearUnreadTab, onActiveTabKeyChange,
  onOpenMobileSidebar,
  onNavigateToTask,
  onNavigateToKnowledge,
  onOpenMcpSettings,
}: MainProps) {
  const { toast } = useDialog();
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showRoomSettings, setShowRoomSettings] = useState(false);
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const [artifactPreview, setArtifactPreview] = useState<MessageArtifactPreviewState | ChatAttachmentPreviewState | null>(null);
  const [surfaceExpanded, setSurfaceExpandedRaw] = useState(() => localStorage.getItem("bossmode_preview_surface") === "expanded");
  const setSurfaceExpanded = (v: boolean) => {
    setSurfaceExpandedRaw(v);
    localStorage.setItem("bossmode_preview_surface", v ? "expanded" : "panel");
  };
  const [taskPreviewId, setTaskPreviewId] = useState<string | null>(null);
  const [previewPct, setPreviewPct] = useState<number>(() => readPreviewPct(localStorage, window.innerWidth));
  const isPreviewDragging = useRef(false);
  const isMobile = useIsMobile();

  useEdgeSwipe({ side: "right", onTrigger: useCallback(() => setMobileMembersOpen(true), []) });

  useEffect(() => {
    if (externalShowCreateRoom) {
      setShowCreateRoom(true);
      onCreateRoomShown?.();
    }
  }, [externalShowCreateRoom, onCreateRoomShown]);

  // 视图：Chat | Tasks
  const [view, setView] = useState<RoomView>("chat");

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

  const displayMemberInfos = useMemo(() => {
    if (room?.roomMembers?.length) {
      return room.roomMembers.map((member) => ({
        id: member.id,
        name: member.name,
        agent: member.sourceAgent,
        sourceAgent: member.sourceAgent,
        roomId: member.roomId || room.id,
        model: member.config?.model ?? null,
        thinkingLevel: member.config?.thinkingLevel || "off",
        avatar: member.avatar,
        contextLimit: member.config?.contextLimit,
        credentialId: member.config?.credentialId ?? null,
        mcpServers: member.config?.mcpServers || [],
      } as MemberInfo));
    }
    return (room?.members || []).map((name) => ({ id: name, name, agent: name, sourceAgent: name, thinkingLevel: "off", mcpServers: [] } as MemberInfo));
  }, [room]);
  const displayMembers = useMemo(() => displayMemberInfos.map((member) => member.name), [displayMemberInfos]);
  const displayMemberAgentHints = useMemo(() => Object.fromEntries(displayMemberInfos.map((member) => [member.name, displayAgentHint(member.agent || member.sourceAgent || member.name)])), [displayMemberInfos]);
  const displayAgentStatus = agentStatus;
  const displayContextUsage = contextUsage;

  useEffect(() => {
    onRegisterWsHandler(handleWsEvent);
  }, [handleWsEvent, onRegisterWsHandler]);

  // 房间切换时重置视图
  useEffect(() => {
    const restoreTab = sessionStorage.getItem("bossmode_main_restore_tab");
    sessionStorage.removeItem("bossmode_main_restore_tab");
    setView(restoreTab === "tasks" ? "tasks" : "chat");
    setArtifactPreview(null);
    setTaskPreviewId(null);
  }, [selectedRoomId]);

  // 通知 Layout 当前关注的 tab key（unread 逻辑）
  useEffect(() => {
    const key = view === "chat" ? "room" : "tasks";
    onActiveTabKeyChange(key);
  }, [view, onActiveTabKeyChange]);

  const switchView = useCallback((v: RoomView) => {
    setView(v);
    if (v !== "chat") {
      setArtifactPreview(null);
      setTaskPreviewId(null);
    }
    if (selectedRoomId) onClearUnreadTab(selectedRoomId, v === "chat" ? "room" : "tasks");
  }, [selectedRoomId, onClearUnreadTab]);

  const handlePreviewResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    isPreviewDragging.current = true;
    const container = (e.currentTarget as HTMLElement).parentElement;
    const containerWidth = container ? container.getBoundingClientRect().width : window.innerWidth;
    const startX = e.clientX;
    const startPct = previewPct;
    const onMove = (move: MouseEvent) => {
      if (!isPreviewDragging.current) return;
      const delta = startX - move.clientX;
      const next = clampPreviewPct(startPct + (delta / containerWidth) * 100);
      setPreviewPct(next);
    };
    const onUp = () => {
      isPreviewDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [previewPct]);

  useEffect(() => {
    localStorage.setItem(PREVIEW_PCT_STORAGE_KEY, formatPreviewPct(previewPct));
  }, [previewPct]);

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
    async (name: string, cwd: string, members: Array<{ agent: string; name: string }>, ruleDocs?: string[], promptLeaderMemberName?: string) => {
      const newRoom = await apiCreateRoom(name, cwd, members, ruleDocs, promptLeaderMemberName);
      onRoomCreated(newRoom);
      setShowCreateRoom(false);
    },
    [onRoomCreated, toast],
  );

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
    } catch (err) {
      console.error("Failed to check summarization", err);
      toast(userActionError("check summarization"), "error");
    }
  }, [selectedRoomId, toast]);

  const handleSummarizeConfirm = useCallback(async () => {
    if (!selectedRoomId) return;
    setSummarizeDialog(null);
    try {
      await apiSummarizeRoom(selectedRoomId, summarizeKeepCount);
      toast("Summarization started.", "success");
    } catch (err) {
      console.error("Failed to start summarization", err);
      toast(userActionError("start summarization"), "error");
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

  const handleAddMember = useCallback(async (agentName: string, memberName?: string) => {
    if (!selectedRoomId) return;
    const name = (memberName || agentName).trim();
    if (!name) return;
    if (displayMembers.some((m) => m.toLowerCase() === name.toLowerCase())) {
      toast(`This room already has a member named ${name}. Pick another name.`, "error");
      return;
    }
    try {
      await apiAddMember(selectedRoomId, agentName, name);
      await reloadRoom();
      setShowAddMember(false);
    } catch (err) {
      console.error("Failed to add Room member", err);
      toast(userActionError("add this member", "Check the Agent and member name, then try again."), "error");
    }
  }, [displayMembers, selectedRoomId, reloadRoom, toast]);

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

      {/* 台口：房间名 + cwd + segmented + 工具组 */}
      <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
        <button
          onClick={() => setShowRoomSettings(true)}
          className="flex items-baseline gap-2.5 min-w-0 rounded-lg px-2 py-1 -ml-2 hover:bg-surface-2 transition-colors text-left cursor-pointer"
          title="Open Room Settings"
        >
          <h2 className="text-sm font-semibold tracking-tight text-ink-1 whitespace-nowrap">{room.name}</h2>
          <span className="font-mono text-[11px] text-ink-4 truncate hidden sm:block">{room.cwd}</span>
        </button>

        <div className="flex bg-inset border border-line-soft rounded-lg p-0.5 shrink-0">
          <button onClick={() => switchView("chat")} className={segBtn(view === "chat")}>
            Chat
            {unreadTabs?.has("room") && view !== "chat" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1.5 align-middle" />}
          </button>
          <button onClick={() => switchView("tasks")} className={segBtn(view === "tasks")}>
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
          <button onClick={() => setShowRoomSettings(true)} className={toolBtn} title="Room Settings">
            <Settings size={13} />
          </button>
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

      {/* 内容区：chat/tasks + 工位墙 */}
      <div className="flex-1 flex min-h-0 bg-surface-1">
        <div className="flex-1 flex flex-col min-w-0">
          {view === "chat" ? (
            <>
              <ChatArea messages={messages} roomName={room.name} roomId={room.id} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} members={displayMembers} onNavigateToTask={selectedRoomId ? (taskId) => { setArtifactPreview(null); setTaskPreviewId(taskId); } : undefined} onNavigateToKnowledge={onNavigateToKnowledge} onPreviewArtifact={(preview) => { setView("chat"); setMobileMembersOpen(false); setTaskPreviewId(null); setArtifactPreview(preview); }} onPreviewAttachment={(preview) => { setView("chat"); setMobileMembersOpen(false); setTaskPreviewId(null); setArtifactPreview(preview); }} activeArtifactPreview={artifactPreview && artifactPreview.kind !== "attachment" ? { messageId: artifactPreview.messageId, selectedIndex: artifactPreview.selectedIndex } : null} activeAttachmentPreview={artifactPreview?.kind === "attachment" ? { messageId: artifactPreview.messageId, storedFilename: artifactPreview.attachments[artifactPreview.selectedIndex]?.storedFilename || "" } : null} onJumpToMessage={jumpToMessage} onReturnToLatest={returnToLatest} inHistoryView={inHistoryView} />
              <MessageInput onSend={sendMessage} members={displayMembers} memberHints={displayMemberAgentHints} disabled={loading} roomId={selectedRoomId || undefined} onError={(msg) => toast(msg, "error")} />
            </>
          ) : selectedRoomId ? (
            <TasksTab
              roomId={selectedRoomId}
              members={displayMembers}
              onOpenTaskDetail={(taskId) => onNavigateToTask?.(selectedRoomId, taskId, "tasks")}
            />
          ) : null}
        </div>

        {(artifactPreview || taskPreviewId) && view === "chat" && selectedRoomId && !isMobile && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={handlePreviewResizeStart}
              className="hidden md:flex w-2 shrink-0 cursor-col-resize items-center justify-center border-l border-line-soft bg-surface-1 hover:bg-accent-dim group"
              title="Drag to resize preview"
            >
              <div className="h-10 w-0.5 rounded-full bg-line-strong group-hover:bg-accent" />
            </div>
            <div className="hidden md:block shrink-0 min-h-0" style={{ width: `${previewPct}%` }}>
              {artifactPreview ? (
                <ArtifactPreviewPanel
                  roomId={selectedRoomId}
                  state={artifactPreview}
                  onSelect={(selectedIndex) => setArtifactPreview((prev) => prev ? { ...prev, selectedIndex } : prev)}
                  onClose={() => setArtifactPreview(null)}
                  variant="panel"
                  onExpand={() => setSurfaceExpanded(true)}
                />
              ) : (
                <TaskPreviewPanel
                  roomId={selectedRoomId}
                  taskId={taskPreviewId!}
                  onExpand={() => setSurfaceExpanded(true)}
                  onOpenFull={() => { const id = taskPreviewId; setTaskPreviewId(null); onNavigateToTask?.(selectedRoomId, id!, "chat"); }}
                  onClose={() => setTaskPreviewId(null)}
                />
              )}
            </div>
          </>
        )}

        {/* 工位墙（桌面） */}
        <div className={`${(artifactPreview || taskPreviewId) && view === "chat" ? "hidden xl:block" : "hidden md:block"} w-[280px] border-l border-line shrink-0`}>
          <StationPanel
            members={displayMembers}
            agentStatus={displayAgentStatus}
            contextUsage={displayContextUsage}
            roomId={room.id}
            onSteer={handleSteer}
            onOpenMcpSettings={onOpenMcpSettings}
            onMembersChanged={reloadRoom}
            unreadAgents={unreadTabs}
          />
        </div>

        {/* 工位墙（移动端抽屉） */}
        {isMobile && (
          <MobileDrawer open={mobileMembersOpen} side="right" onClose={() => setMobileMembersOpen(false)} width="w-80">
            <StationPanel
              members={displayMembers}
              agentStatus={displayAgentStatus}
              contextUsage={displayContextUsage}
              roomId={room.id}
              onSteer={handleSteer}
              onOpenMcpSettings={onOpenMcpSettings}
              onMembersChanged={reloadRoom}
              unreadAgents={unreadTabs}
            />
          </MobileDrawer>
        )}
      </div>

      {artifactPreview && selectedRoomId && isMobile && !surfaceExpanded && (
        <Sheet open={!!artifactPreview} onClose={() => setArtifactPreview(null)} closeOnOverlayClick size="2xl">
          <div className="h-[86vh] min-h-0">
            <ArtifactPreviewPanel
              roomId={selectedRoomId}
              state={artifactPreview}
              onSelect={(selectedIndex) => setArtifactPreview((prev) => prev ? { ...prev, selectedIndex } : prev)}
              onClose={() => setArtifactPreview(null)}
              variant="sheet"
              onExpand={() => setSurfaceExpanded(true)}
            />
          </div>
        </Sheet>
      )}

      {taskPreviewId && selectedRoomId && (surfaceExpanded || isMobile) && (
        <TaskPreviewSurface
          roomId={selectedRoomId}
          taskId={taskPreviewId}
          onOpenFull={() => { const id = taskPreviewId; setTaskPreviewId(null); onNavigateToTask?.(selectedRoomId, id!, "chat"); }}
          onCollapse={!isMobile ? () => setSurfaceExpanded(false) : undefined}
          onClose={() => setTaskPreviewId(null)}
        />
      )}

      {artifactPreview && selectedRoomId && surfaceExpanded && (
        <PreviewSurface
          roomId={selectedRoomId}
          state={previewSurfaceStateFrom(artifactPreview)}
          onSelect={(selectedIndex) => setArtifactPreview((prev) => prev ? { ...prev, selectedIndex } : prev)}
          onCollapse={() => setSurfaceExpanded(false)}
          onClose={() => { setSurfaceExpanded(false); setArtifactPreview(null); }}
        />
      )}

      {showCreateRoom && (
        <CreateRoomDialog onClose={() => setShowCreateRoom(false)} onSubmit={handleCreateRoom} />
      )}
      {showRoomSettings && (
        <RoomSettingsDialog
          room={room}
          open={showRoomSettings}
          onClose={() => setShowRoomSettings(false)}
          onSaved={async () => { await reloadRoom(); (window as any).__bossmode_refreshSidebar?.(); }}
          onDeleted={(roomId) => { (window as any).__bossmode_refreshSidebar?.(); onRoomDeleted?.(roomId); }}
        />
      )}
      {showAddMember && (
        <AddMemberDialog currentMembers={displayMembers} currentMemberInfos={displayMemberInfos} onAdd={handleAddMember} onClose={() => setShowAddMember(false)} />
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
