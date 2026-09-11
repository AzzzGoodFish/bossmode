import { memberTitleHints } from "../utils/member-title-hints";
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Room, MemberInfo } from "../api/client";
import { useIsMobile } from "../hooks/useIsMobile";
import { useEdgeSwipe } from "../hooks/useEdgeSwipe";
import { MobileDrawer } from "../components/MobileDrawer";
import { ChatAvatar, memberStateLabel } from "../components/ChatAvatar";
import { ChatMemberPeek } from "../components/ChatMemberPeek";
import { Sheet } from "../components/Sheet";
import {
  Search,
  Plus,
  Settings,
  X,
  Menu,
  MoreHorizontal,
  Users,
  Activity,
} from "lucide-react";
import {
  createRoom as apiCreateRoom,
  inviteRoomMember,
  type RoomMessage,
} from "../api/client";
import { useRoom } from "../hooks/useRoom";
import { useGlobalMembers } from "../hooks/useGlobalMembers";
import type { WsEvent } from "../hooks/useWebSocket";
import { ChatArea } from "../components/ChatArea";
import {
  ArtifactPreviewPanel,
  type MessageArtifactPreviewState,
  type ChatAttachmentPreviewState,
} from "../components/ArtifactPreviewPanel";
import {
  PreviewSurface,
  previewSurfaceStateFrom,
} from "../components/PreviewSurface";
import { StationPanel } from "../components/StationPanel";
import { ResizableRail } from "../components/ResizableRail";
import { MessageInput } from "../components/MessageInput";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { AddMemberDialog } from "../components/AddMemberDialog";
import { RoomSettingsDialog } from "../components/RoomSettingsDialog";
import { useDialog } from "../components/dialogs";
import {
  clampPreviewPct,
  formatPreviewPct,
  PREVIEW_PCT_STORAGE_KEY,
  readPreviewPct,
} from "../utils/preview-pane-sizing";

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
  onOpenDm?: (memberId: string) => void;
}

export function Main({
  selectedRoomId,
  onSelectRoom,
  onRoomCreated,
  onRoomDeleted,
  username,
  externalShowCreateRoom,
  onCreateRoomShown,
  connected,
  reconnecting,
  onRegisterWsHandler,
  unreadTabs,
  onClearUnreadTab,
  onActiveTabKeyChange,
  onOpenMobileSidebar,
  onOpenDm,
}: MainProps) {
  const { toast } = useDialog();
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showRoomSettings, setShowRoomSettings] = useState(false);
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const [peekMemberId, setPeekMemberId] = useState<string | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mentionRequest, setMentionRequest] = useState<{
    name: string;
    nonce: number;
  } | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const roomInfoCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!mobileMembersOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    roomInfoCloseRef.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !document.querySelector(
          '[data-member-float],[aria-modal="true"],.bm-popover,.bm-header-menu',
        )
      )
        setMobileMembersOpen(false);
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [mobileMembersOpen]);
  useEffect(() => {
    if (!moreOpen) return;
    const pointer = (e: PointerEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [moreOpen]);
  const openPeek = (id: string) => {
    setPeekMemberId(id);
    setMobileMembersOpen(false);
    setArtifactPreview(null);
    setShowActivity(false);
  };
  const openRoomInfo = () => {
    setPeekMemberId(null);
    setArtifactPreview(null);
    setShowActivity(false);
    setMobileMembersOpen((v) => !v);
  };
  const [artifactPreview, setArtifactPreview] = useState<
    MessageArtifactPreviewState | ChatAttachmentPreviewState | null
  >(null);
  const [surfaceExpanded, setSurfaceExpandedRaw] = useState(
    () => localStorage.getItem("bossmode_preview_surface") === "expanded",
  );
  const setSurfaceExpanded = (v: boolean) => {
    setSurfaceExpandedRaw(v);
    localStorage.setItem("bossmode_preview_surface", v ? "expanded" : "panel");
  };
  // ── Quote reply (plan-reply-to-v1) ──
  const [replyQuote, setReplyQuote] = useState<{
    seq: number;
    messageId: string;
    sender: string;
    senderMemberId?: string;
    excerpt: string;
  } | null>(null);
  const [previewPct, setPreviewPct] = useState<number>(() =>
    readPreviewPct(localStorage, window.innerWidth),
  );
  const isPreviewDragging = useRef(false);
  const isMobile = useIsMobile();

  useEdgeSwipe({
    side: "right",
    onTrigger: useCallback(() => {
      setPeekMemberId(null);
      setArtifactPreview(null);
      setShowActivity(false);
      setMobileMembersOpen(true);
    }, []),
  });

  useEffect(() => {
    if (externalShowCreateRoom) {
      setShowCreateRoom(true);
      onCreateRoomShown?.();
    }
  }, [externalShowCreateRoom, onCreateRoomShown]);

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

  const globalMembers = useGlobalMembers();

  const displayMemberInfos = useMemo(() => {
    // 0.20: compose from room.globalMemberIds + contacts (roomMembers array is being removed — G3 debt ②).
    if (room?.globalMemberIds?.length) {
      return room.globalMemberIds.map((gid) => {
        const c = globalMembers.get(gid);
        return {
          id: gid,
          name: c?.name ?? gid.slice(0, 12),
          title: c?.title,
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
    return (room?.members || []).map(
      (name) =>
        ({
          id: name,
          name,
          agent: name,
          sourceAgent: name,
          thinkingLevel: "off",
          mcpServers: [],
        }) as MemberInfo,
    );
  }, [room, globalMembers]);
  const displayMembers = useMemo(
    () => displayMemberInfos.map((member) => member.name),
    [displayMemberInfos],
  );
  const displayMemberHints = useMemo(
    () => memberTitleHints(displayMemberInfos),
    [displayMemberInfos],
  );
  const displayAgentStatus = agentStatus;
  const displayContextUsage = contextUsage;

  useEffect(() => {
    onRegisterWsHandler(handleWsEvent);
  }, [handleWsEvent, onRegisterWsHandler]);

  // 房间切换时重置视图
  useEffect(() => {
    setPeekMemberId(null);
    setMobileMembersOpen(false);
    setShowActivity(false);
    setArtifactPreview(null);
  }, [selectedRoomId]);

  // 通知 Layout 当前关注的 tab key（unread 逻辑）
  useEffect(() => {
    onActiveTabKeyChange("room");
  }, [onActiveTabKeyChange]);

  const handlePreviewResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      isPreviewDragging.current = true;
      const container = (e.currentTarget as HTMLElement).parentElement;
      const containerWidth = container
        ? container.getBoundingClientRect().width
        : window.innerWidth;
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
    },
    [previewPct],
  );

  useEffect(() => {
    localStorage.setItem(PREVIEW_PCT_STORAGE_KEY, formatPreviewPct(previewPct));
  }, [previewPct]);

  const handleCreateRoom = useCallback(
    async (name: string, memberIds: string[], leaderMemberId: string) => {
      const newRoom = await apiCreateRoom(name, memberIds, leaderMemberId);
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
  const handleAddMember = useCallback(
    async (memberId: string) => {
      if (!selectedRoomId) return;
      await inviteRoomMember(selectedRoomId, memberId);
      await reloadRoom();
      setShowAddMember(false);
    },
    [selectedRoomId, reloadRoom],
  );

  if (!room) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-1">
        <div className="text-center">
          <p className="text-ink-3 text-lg mb-3">选择一个房间开始聊天</p>
          <button
            onClick={() => setShowCreateRoom(true)}
            className="px-4 py-2 bg-accent text-accent-contrast text-sm font-semibold rounded-md transition-opacity hover:opacity-90 cursor-pointer"
          >
            创建房间
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
      <header className="bm-chat-header">
        <button
          className="bm-icon-btn bm-mobile-nav"
          aria-label="打开会话导航"
          onClick={onOpenMobileSidebar}
        >
          <Menu size={20} />
        </button>
        <button
          className="bm-chat-title"
          onClick={openRoomInfo}
          title="查看房间详情"
        >
          <ChatAvatar name={room.name} room />
          <span>
            <h1>{room.name}</h1>
            <span className="bm-chat-subtitle">
              {displayMembers.length} 位成员 · 房间
            </span>
          </span>
        </button>
        <div className="bm-header-right">
          <div className="bm-member-stack" aria-label="房间成员">
            {displayMemberInfos.slice(0, 5).map((m) => (
              <button
                key={m.id}
                onClick={() => openPeek(m.id)}
                aria-label={`查看 ${m.name} 的详情`}
              >
                <ChatAvatar
                  name={m.name}
                  identity={m.id}
                  status={displayAgentStatus[m.name]}
                  size="sm"
                />
              </button>
            ))}
          </div>
          {!connected && (
            <span
              className="bm-header-connection text-[10px] text-blocked"
              role="status"
            >
              {reconnecting ? "正在重连" : "连接已断开"}
            </span>
          )}
          <button
            className="bm-icon-btn"
            onClick={() => setSearchOpen((v) => !v)}
            aria-label="搜索本会话"
            title="搜索本会话 · Ctrl / ⌘ F"
          >
            <Search size={18} />
          </button>
          <div className="relative" ref={moreRef}>
            <button
              className="bm-icon-btn"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-label="会话菜单"
            >
              <MoreHorizontal size={18} />
            </button>
            {moreOpen && (
              <div className="bm-header-menu">
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    openRoomInfo();
                  }}
                >
                  <Users size={15} />
                  房间成员
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setShowAddMember(true);
                  }}
                >
                  <Plus size={15} />
                  添加成员
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setShowRoomSettings(true);
                  }}
                >
                  <Settings size={15} />
                  房间设置
                </button>
                <button
                  onClick={() => {
                    setMoreOpen(false);
                    setPeekMemberId(null);
                    setMobileMembersOpen(false);
                    setArtifactPreview(null);
                    setShowActivity(true);
                  }}
                >
                  <Activity size={15} />
                  查看活动
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="bm-chat-content">
        <div className="bm-conversation-column">
          <>
            <ChatArea
              messages={messages}
              roomName={room.name}
              roomId={room.id}
              hasMore={hasMore}
              loadingOlder={loadingOlder}
              onLoadOlder={loadOlder}
              searchOpen={searchOpen}
              onCloseSearch={() => setSearchOpen(false)}
              members={displayMembers}
              memberIdentities={displayMemberInfos}
              onMemberClick={openPeek}
              onPreviewArtifact={(preview) => {
                setPeekMemberId(null);
                setShowActivity(false);
                setMobileMembersOpen(false);
                setArtifactPreview(preview);
              }}
              onPreviewAttachment={(preview) => {
                setPeekMemberId(null);
                setShowActivity(false);
                setMobileMembersOpen(false);
                setArtifactPreview(preview);
              }}
              activeArtifactPreview={
                artifactPreview && artifactPreview.kind !== "attachment"
                  ? {
                      messageId: artifactPreview.messageId,
                      selectedIndex: artifactPreview.selectedIndex,
                    }
                  : null
              }
              activeAttachmentPreview={
                artifactPreview?.kind === "attachment"
                  ? {
                      messageId: artifactPreview.messageId,
                      storedFilename:
                        artifactPreview.attachments[
                          artifactPreview.selectedIndex
                        ]?.storedFilename || "",
                    }
                  : null
              }
              onJumpToMessage={jumpToMessage}
              onReturnToLatest={returnToLatest}
              inHistoryView={inHistoryView}
              onReplyMessage={(msg) =>
                setReplyQuote({
                  seq: msg.seq ?? 0,
                  messageId: msg.id,
                  sender: msg.sender === "user" ? "you" : msg.sender,
                  senderMemberId: msg.senderMemberId,
                  excerpt:
                    (msg.content || "")
                      .split("\n")
                      .find((l) => l.trim())
                      ?.slice(0, 60) ?? "",
                })
              }
            />
            {displayMembers.some(
              (name) => displayAgentStatus[name] === "working",
            ) && (
              <div className="bm-work-note" role="status">
                {displayMembers
                  .filter((name) => displayAgentStatus[name] === "working")
                  .join("、")}{" "}
                正在工作
              </div>
            )}
            <MessageInput
              scopeLabel={room.name}
              mentionRequest={mentionRequest}
              onSend={async (content, atts) => {
                const q = replyQuote;
                await sendMessage(
                  content,
                  atts,
                  q ? { seq: q.seq } : undefined,
                );
                setReplyQuote(null);
                window.dispatchEvent(
                  new Event("bossmode:conversations-changed"),
                );
              }}
              members={displayMembers}
              memberHints={displayMemberHints}
              disabled={loading}
              roomId={selectedRoomId || undefined}
              onError={(msg) => toast(msg, "error")}
              quote={replyQuote}
              onClearQuote={() => setReplyQuote(null)}
            />
          </>
        </div>

        {artifactPreview && selectedRoomId && !isMobile && (
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
            <div
              className="hidden md:block shrink-0 min-h-0"
              style={{ width: `${previewPct}%` }}
            >
              <ArtifactPreviewPanel
                roomId={selectedRoomId}
                state={artifactPreview}
                onSelect={(selectedIndex) =>
                  setArtifactPreview((prev) =>
                    prev ? { ...prev, selectedIndex } : prev,
                  )
                }
                onClose={() => setArtifactPreview(null)}
                variant="panel"
                onExpand={() => setSurfaceExpanded(true)}
              />
            </div>
          </>
        )}

        {peekMemberId && (
          <ChatMemberPeek
            memberId={peekMemberId}
            scopeId={`room:${room.id}`}
            status={
              displayAgentStatus[
                displayMemberInfos.find((m) => m.id === peekMemberId)?.name ||
                  ""
              ]
            }
            onClose={() => setPeekMemberId(null)}
            onOpenDm={onOpenDm}
            onMention={
              displayMemberInfos.some((m) => m.id === peekMemberId)
                ? (name) => {
                    setMentionRequest({ name, nonce: Date.now() });
                    if (window.innerWidth <= 960) setPeekMemberId(null);
                  }
                : undefined
            }
          />
        )}
        {mobileMembersOpen && (
          <aside className="bm-detail" aria-label="房间详情">
            <div className="bm-detail-head">
              <span>房间详情</span>
              <button
                className="bm-icon-btn"
                ref={roomInfoCloseRef}
                aria-label="关闭房间详情"
                onClick={() => setMobileMembersOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="bm-detail-identity">
              <ChatAvatar name={room.name} room size="lg" />
              <h2>{room.name}</h2>
              <p>{displayMembers.length} 位成员</p>
              <div className="bm-detail-actions">
                <button
                  className="bm-btn"
                  onClick={() => setShowRoomSettings(true)}
                >
                  <Settings size={14} />
                  房间设置
                </button>
                <button
                  className="bm-btn"
                  onClick={() => setShowAddMember(true)}
                >
                  <Plus size={14} />
                  添加成员
                </button>
              </div>
            </div>
            <div className="bm-room-roster">
              {displayMemberInfos.map((m) => (
                <button
                  className="bm-person-item"
                  key={m.id}
                  onClick={() => openPeek(m.id)}
                  aria-label={`查看 ${m.name} 的详情`}
                >
                  <ChatAvatar
                    name={m.name}
                    identity={m.id}
                    status={displayAgentStatus[m.name]}
                  />
                  <span>
                    <span className="bm-roster-name">{m.name}</span>
                    <span className="bm-roster-status">
                      {memberStateLabel(displayAgentStatus[m.name])}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </aside>
        )}
        {showActivity && !isMobile && (
          <ResizableRail className="hidden md:block">
            <div className="relative flex flex-col h-full">
              <div className="bm-detail-head">
                <span>会话活动</span>
                <button
                  className="bm-icon-btn"
                  aria-label="关闭会话活动"
                  onClick={() => setShowActivity(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 min-h-0">
                <StationPanel
                  members={displayMembers}
                  agentStatus={displayAgentStatus}
                  contextUsage={displayContextUsage}
                  roomId={room.id}
                  onJumpToMessage={jumpToMessage}
                  onMembersChanged={reloadRoom}
                  unreadAgents={unreadTabs}
                />
              </div>
            </div>
          </ResizableRail>
        )}
        {isMobile && showActivity && (
          <MobileDrawer
            open={showActivity}
            side="right"
            onClose={() => setShowActivity(false)}
            width="w-80"
          >
            <StationPanel
              members={displayMembers}
              agentStatus={displayAgentStatus}
              contextUsage={displayContextUsage}
              roomId={room.id}
              onJumpToMessage={jumpToMessage}
              onMembersChanged={reloadRoom}
              unreadAgents={unreadTabs}
            />
          </MobileDrawer>
        )}
      </div>

      {artifactPreview && selectedRoomId && isMobile && !surfaceExpanded && (
        <Sheet
          open={!!artifactPreview}
          onClose={() => setArtifactPreview(null)}
          closeOnOverlayClick
          size="2xl"
        >
          <div className="h-[86vh] min-h-0">
            <ArtifactPreviewPanel
              roomId={selectedRoomId}
              state={artifactPreview}
              onSelect={(selectedIndex) =>
                setArtifactPreview((prev) =>
                  prev ? { ...prev, selectedIndex } : prev,
                )
              }
              onClose={() => setArtifactPreview(null)}
              variant="sheet"
              onExpand={() => setSurfaceExpanded(true)}
            />
          </div>
        </Sheet>
      )}

      {artifactPreview && selectedRoomId && surfaceExpanded && (
        <PreviewSurface
          roomId={selectedRoomId}
          state={previewSurfaceStateFrom(artifactPreview)}
          onSelect={(selectedIndex) =>
            setArtifactPreview((prev) =>
              prev ? { ...prev, selectedIndex } : prev,
            )
          }
          onCollapse={() => setSurfaceExpanded(false)}
          onClose={() => {
            setSurfaceExpanded(false);
            setArtifactPreview(null);
          }}
        />
      )}

      {showCreateRoom && (
        <CreateRoomDialog
          onClose={() => setShowCreateRoom(false)}
          onSubmit={handleCreateRoom}
        />
      )}
      {showRoomSettings && (
        <RoomSettingsDialog
          room={room}
          open={showRoomSettings}
          onClose={() => setShowRoomSettings(false)}
          onSaved={async () => {
            await reloadRoom();
            (window as any).__bossmode_refreshSidebar?.();
          }}
          onDeleted={(roomId) => {
            (window as any).__bossmode_refreshSidebar?.();
            onRoomDeleted?.(roomId);
          }}
        />
      )}
      {showAddMember && (
        <AddMemberDialog
          currentMemberIds={displayMemberInfos.map((m) => m.id)}
          onAdd={handleAddMember}
          onClose={() => setShowAddMember(false)}
        />
      )}
    </>
  );
}
