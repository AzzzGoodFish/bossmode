import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import type { Room, MemberInfo } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { MobileTopBar } from "../components/MobileTopBar";
import { Sheet } from "../components/Sheet";
import { ContractDriftDialog } from "../components/ContractDriftDialog";
import { Search, Plus, Settings, X } from "lucide-react";
import { TasksTab } from "./TasksTab";
import {
  createRoom as apiCreateRoom,
  inviteRoomMember,
  getContractDrift,
  dismissContractDrift,
  createTopic,
  type ContractDriftEntry,
  type RoomMessage,
} from "../api/client";
import { useRoom } from "../hooks/useRoom";
import { useGlobalMembers } from "../hooks/useGlobalMembers";
import type { WsEvent } from "../hooks/useWebSocket";
import { ChatArea } from "../components/ChatArea";
import { ArtifactPreviewPanel, type MessageArtifactPreviewState, type ChatAttachmentPreviewState } from "../components/ArtifactPreviewPanel";
import { PreviewSurface, previewSurfaceStateFrom } from "../components/PreviewSurface";
import { TaskPreviewSurface, TaskPreviewPanel } from "../components/TaskPreviewSurface";
import { StationPanel } from "../components/StationPanel";
import { ResizableRail } from "../components/ResizableRail";
import { MessageInput } from "../components/MessageInput";
import { TopicRail, TopicRailToggle, useRoomTopics, useTopicRailOpen } from "../components/TopicRail";
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
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
  /** Navigate to a topic workspace page (topic-threads v2 — replaces the v1 panel/Surface). */
  onOpenTopicPage?: (roomId: string, topicId: string) => void;
  /** Open an unsent topic draft on a message (topic-threads v3 — creates on first send, Feishu semantics). */
  onOpenTopicDraft?: (roomId: string, anchor: { anchorMessageId: string; anchorSeq?: number; title: string; excerpt: string }) => void;
  /** Cross-page jump (topic anchor block → this room's message): consumed once the room is loaded. */
  pendingJump?: { roomId: string; messageId: string } | null;
  onConsumeJump?: () => void;
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
  onOpenMcpSettings,
  onOpenExtensionsSettings,
  onOpenTopicPage,
  onOpenTopicDraft,
  pendingJump,
  onConsumeJump,
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
  // ── Topic rail (fish pick 2026-08-19: direction A + collapsible) ──
  const [topicRailOpen, toggleTopicRail] = useTopicRailOpen(selectedRoomId);
  const { topics: roomTopics, activeCount: topicActiveCount } = useRoomTopics(selectedRoomId);
  // ── Quote reply + topic composer mode (plan-reply-to-v1 / topic-threads v2) ──
  const [replyQuote, setReplyQuote] = useState<{ seq: number; messageId: string; sender: string; excerpt: string } | null>(null);
  const [topicMode, setTopicMode] = useState(false);
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

  // Cross-page jump: topic anchor block asked us to land on a specific room message.
  useEffect(() => {
    if (!pendingJump || pendingJump.roomId !== selectedRoomId || loading) return;
    void jumpToMessage(pendingJump.messageId);
    onConsumeJump?.();
  }, [pendingJump, selectedRoomId, loading, jumpToMessage, onConsumeJump]);

  const globalMembers = useGlobalMembers();

  // ── Contract drift detection (auto-reload prompt) ──
  const [driftMembers, setDriftMembers] = useState<Array<ContractDriftEntry & { status: string }>>([]);
  const [driftOpen, setDriftOpen] = useState(false);
  useEffect(() => {
    if (!selectedRoomId) { setDriftMembers([]); setDriftOpen(false); return; }
    let cancelled = false;
    getContractDrift(selectedRoomId)
      .then((entries) => {
        if (cancelled) return;
        const withStatus = entries.map((e) => ({
          ...e,
          status: agentStatus[e.memberName] ?? "inactive",
        }));
        // Only show the modal for entries not already notified.
        const unnotified = withStatus.filter((e) => !e.alreadyNotified);
        setDriftMembers(unnotified);
        setDriftOpen(unnotified.length > 0);
      })
      .catch(() => { /* quiet — don't block on API failure */ });
    return () => { cancelled = true; };
  }, [selectedRoomId]);

  const closeDrift = useCallback(() => {
    setDriftOpen(false);
    if (selectedRoomId) {
      dismissContractDrift(selectedRoomId).then(() => {
        // The dismiss endpoint broadcasts stale status via WS; also reload to pick up agentStale.
        reloadRoom();
      }).catch(() => {});
    }
  }, [selectedRoomId, reloadRoom]);
  const displayMemberInfos = useMemo(() => {
    // 0.20: compose from room.globalMemberIds + contacts (roomMembers array is being removed — G3 debt ②).
    if (room?.globalMemberIds?.length) {
      return room.globalMemberIds.map((gid) => {
        const c = globalMembers.get(gid);
        return {
          id: gid,
          name: c?.name ?? gid.slice(0, 12),
          agent: c?.agentTemplate ?? "general",
          sourceAgent: c?.agentTemplate ?? "general",
          roomId: room.id,
          model: c?.model ?? null,
          thinkingLevel: "off",
          contextLimit: undefined,
          credentialId: null,
          mcpServers: [],
        } as MemberInfo;
      });
    }
    return (room?.members || []).map((name) => ({ id: name, name, agent: name, sourceAgent: name, thinkingLevel: "off", mcpServers: [] } as MemberInfo));
  }, [room, globalMembers]);
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

  const handleCreateRoom = useCallback(
    async (name: string, cwd: string, members: Array<{ agent: string; name: string }>, ruleDocs?: string[], promptLeaderMemberName?: string) => {
      const newRoom = await apiCreateRoom(name, cwd, members, ruleDocs, promptLeaderMemberName);
      onRoomCreated(newRoom);
      setShowCreateRoom(false);
    },
    [onRoomCreated, toast],
  );

  const [searchOpen, setSearchOpen] = useState(false);

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

  // 0.20: room invite = add an existing global member by id.
  const handleAddMember = useCallback(async (memberId: string) => {
    if (!selectedRoomId) return;
    await inviteRoomMember(selectedRoomId, memberId);
    await reloadRoom();
    setShowAddMember(false);
  }, [selectedRoomId, reloadRoom]);

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
          <TopicRailToggle open={topicRailOpen} activeCount={topicActiveCount} onToggle={toggleTopicRail} />
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
          <button onClick={() => setSearchOpen((v) => !v)} className={toolBtn} title="Search messages (Ctrl+F)">
            <Search size={13} />
          </button>
        </div>
      </div>

      {/* 内容区：chat/tasks + 工位墙 */}
      <div className="flex-1 flex min-h-0 bg-surface-1">
        {/* Topic rail (v3): embedded, collapsible via the topbar Topics button; chat view only */}
        {topicRailOpen && view === "chat" && selectedRoomId && (
          <TopicRail
            topics={roomTopics}
            currentTopicId={null}
            onSelectRoom={() => {}}
            onSelectTopic={(topicId) => onOpenTopicPage?.(selectedRoomId, topicId)}
            onClose={toggleTopicRail}
          />
        )}
        <div className="flex-1 flex flex-col min-w-0">
          {view === "chat" ? (
            <>
              <ChatArea messages={messages} roomName={room.name} roomId={room.id} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} searchOpen={searchOpen} onCloseSearch={() => setSearchOpen(false)} members={displayMembers} onNavigateToTask={selectedRoomId ? (taskId) => { setArtifactPreview(null); setTaskPreviewId(taskId); } : undefined} onPreviewArtifact={(preview) => { setView("chat"); setMobileMembersOpen(false); setTaskPreviewId(null); setArtifactPreview(preview); }} onPreviewAttachment={(preview) => { setView("chat"); setMobileMembersOpen(false); setTaskPreviewId(null); setArtifactPreview(preview); }} activeArtifactPreview={artifactPreview && artifactPreview.kind !== "attachment" ? { messageId: artifactPreview.messageId, selectedIndex: artifactPreview.selectedIndex } : null} activeAttachmentPreview={artifactPreview?.kind === "attachment" ? { messageId: artifactPreview.messageId, storedFilename: artifactPreview.attachments[artifactPreview.selectedIndex]?.storedFilename || "" } : null} onJumpToMessage={jumpToMessage} onReturnToLatest={returnToLatest} inHistoryView={inHistoryView} onReplyMessage={(msg) => setReplyQuote({ seq: msg.seq ?? 0, messageId: msg.id, sender: msg.sender === "user" ? "you" : msg.sender, excerpt: (msg.content || "").split("\n").find((l) => l.trim())?.slice(0, 60) ?? "" })} onCreateTopicFromMessage={(msg) => {
                if (!selectedRoomId) return;
                const firstLine = (msg.content || "").split("\n").find((l) => l.trim())?.trim() ?? "";
                const excerpt = (msg.content || "").replace(/\s+/g, " ").slice(0, 120);
                onOpenTopicDraft?.(selectedRoomId, {
                  anchorMessageId: msg.id,
                  anchorSeq: typeof msg.seq === "number" ? msg.seq : undefined,
                  title: firstLine.slice(0, 80) || "New topic",
                  excerpt,
                });
              }} onOpenTopic={(topicId) => selectedRoomId && onOpenTopicPage?.(selectedRoomId, topicId)} />
              <MessageInput onSend={(content, atts) => { const q = replyQuote; setReplyQuote(null); if (topicMode && selectedRoomId) { setTopicMode(false); return createTopic(selectedRoomId, { content, ...(atts?.length ? { attachments: atts } : {}) }).then((r) => onOpenTopicPage?.(selectedRoomId, r.topic.id)).catch((e) => { toast(e instanceof Error ? e.message : "Failed to create topic", "error"); }); } return sendMessage(content, atts, q ? { seq: q.seq } : undefined); }} members={displayMembers} memberHints={displayMemberAgentHints} disabled={loading} roomId={selectedRoomId || undefined} onError={(msg) => toast(msg, "error")} quote={replyQuote} onClearQuote={() => setReplyQuote(null)} topicMode={{ active: topicMode, onToggle: () => setTopicMode((v) => !v) }} />
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

        {/* 工位墙（桌面，可拖拽调宽 fish 2026-08-21） */}
        <ResizableRail className={`${(artifactPreview || taskPreviewId) && view === "chat" ? "hidden xl:block" : "hidden md:block"}`}>
          <StationPanel
            members={displayMembers}
            agentStatus={displayAgentStatus}
            contextUsage={displayContextUsage}
            roomId={room.id}
            onJumpToMessage={jumpToMessage}
            onOpenMcpSettings={onOpenMcpSettings}
            onOpenExtensionsSettings={onOpenExtensionsSettings}
            onMembersChanged={reloadRoom}
            unreadAgents={unreadTabs}
          />
        </ResizableRail>

        {/* 工位墙（移动端抽屉） */}
        {isMobile && (
          <MobileDrawer open={mobileMembersOpen} side="right" onClose={() => setMobileMembersOpen(false)} width="w-80">
            <StationPanel
              members={displayMembers}
              agentStatus={displayAgentStatus}
                contextUsage={displayContextUsage}
              roomId={room.id}
              onJumpToMessage={jumpToMessage}
              onOpenMcpSettings={onOpenMcpSettings}
            onOpenExtensionsSettings={onOpenExtensionsSettings}
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
        <AddMemberDialog currentMemberIds={displayMemberInfos.map((m) => m.id)} onAdd={handleAddMember} onClose={() => setShowAddMember(false)} />
      )}
      {driftOpen && driftMembers.length > 0 && selectedRoomId && (
        <ContractDriftDialog
          roomId={selectedRoomId}
          members={driftMembers}
          onClose={closeDrift}
          onApplied={() => { reloadRoom(); }}
          onError={(msg) => toast(msg, "error")}
        />
      )}
    </>
  );
}
