/**
 * DmPage — direct-message conversation with a member (scope = dm).
 * The chat surface is the room chat language instantiated for one member:
 * MessageBubble + date separators + 5-min grouping + MessageInput (Chat &
 * List Unification v1). The member panel is the SAME Sheet component the room
 * uses (Member Panel Unification v1): one component, one entry ("click the
 * member → panel"), data scoped to dm:<memberId> — "this DM" tags.
 * Data: /api/members/:id, /api/dm/:memberId/{messages,session}; realtime via
 * WS room:message on dm:<memberId>.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRight } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { DateSeparator, isGroupedWithPrev, shouldShowDateSeparator, MessageArtifactChips } from "../components/ChatArea";
import { Sheet } from "../components/Sheet";
import { MemberConfigPanel, isAssignableMcpServer } from "../components/StationPanel";
import { useDialog } from "../components/dialogs";
import {
  getMemberDetail, getDmMessages, getDmSession, sendDmMessage, postConversationRead,
  getMemberEffectiveConfig, getConversationSession, getConfiguredModels, getMcpSettings, getExtensions,
  patchMemberScopeConfig, patchGlobalMember, conversationMemberAction,
  type MemberDetail, type MemberInfo, type DmMessage, type DmSession,
  type AvailableModelOption, type McpServerSummary, type ExtensionRecord, type ContextUsageData,
} from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";
import { getUsername } from "../api/client";

const PAGE_SIZE = 50;
const toolBtn = "w-7 h-7 flex items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 transition-colors cursor-pointer";

export function DmPage({ memberId, onBack, onOpenSettings, onOpenMcpSettings, onOpenExtensionsSettings }: {
  memberId: string;
  onBack: () => void;
  onOpenSettings?: (memberId: string) => void;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
}) {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [memberInfo, setMemberInfo] = useState<MemberInfo | null>(null);
  const [session, setSession] = useState<DmSession | null>(null);
  const [messages, setMessages] = useState<DmMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [contextUsage, setContextUsage] = useState<ContextUsageData | undefined>();
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [mcpLoadStatus, setMcpLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [installedExtensions, setInstalledExtensions] = useState<ExtensionRecord[]>([]);
  const [extensionsLoadStatus, setExtensionsLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const { toast, confirm } = useDialog();

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const dmScopeId = `dm:${memberId}`;
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // MemberInfo the shared panel expects = member identity + effective config
  // in this DM scope (model/thinking/mcp/extensions all scope-resolved).
  const refreshMemberInfo = useCallback(async (detail: MemberDetail) => {
    const eff = await getMemberEffectiveConfig(detail.memberId, dmScopeId).catch(() => null);
    setMemberInfo({
      id: detail.memberId,
      name: detail.name,
      agent: detail.agentTemplate,
      model: eff?.model ?? detail.global?.model ?? null,
      credentialId: eff?.credentialId ?? detail.global?.credentialId ?? null,
      thinkingLevel: eff?.thinkingLevel ?? detail.global?.thinkingLevel ?? "",
      mcpServers: eff?.mcpServers ?? detail.global?.mcpServers ?? [],
      extensions: eff?.extensions ?? detail.global?.extensions ?? [],
      createdAt: detail.createdAt,
    });
  }, [dmScopeId]);

  const load = useCallback(async () => {
    try {
      const [m, msgs, sess] = await Promise.all([
        getMemberDetail(memberId),
        getDmMessages(memberId, { limit: PAGE_SIZE }),
        getDmSession(memberId).catch(() => null),
      ]);
      setMember(m);
      void refreshMemberInfo(m);
      setMessages(msgs.messages);
      setHasMore(msgs.messages.length >= PAGE_SIZE);
      setSession(sess);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    }
  }, [memberId, refreshMemberInfo]);

  useEffect(() => { void load(); }, [load]);

  // Panel data loads on first open (Sheet is on-demand, same as the room).
  useEffect(() => {
    if (!panelOpen) return;
    void getConfiguredModels().then(setModels).catch(() => {});
    setMcpLoadStatus("loading");
    void getMcpSettings()
      .then((s) => { setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); })
      .catch(() => setMcpLoadStatus("error"));
    setExtensionsLoadStatus("loading");
    void getExtensions()
      .then((e) => { setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); })
      .catch(() => setExtensionsLoadStatus("error"));
    void getConversationSession(dmScopeId, memberId)
      .then((s) => setContextUsage(s.contextUsage))
      .catch(() => {});
  }, [panelOpen, dmScopeId, memberId]);

  // Realtime: member replies arrive as room:message on the synthetic dm:<id> room.
  const dmRoomId = `dm:${memberId}`;
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === "room:message" && event.roomId === dmRoomId) {
        const msg = event.message as DmMessage;
        setMessages((prev) => {
          if (prev?.some((m) => m.id === msg.id)) return prev;
          return [...(prev ?? []), msg];
        });
      }
    },
    [dmRoomId],
  );
  const { subscribeRoom, unsubscribeRoom } = useWebSocket({ onEvent: handleWsEvent });
  useEffect(() => {
    subscribeRoom(dmRoomId);
    return () => unsubscribeRoom(dmRoomId);
  }, [dmRoomId, subscribeRoom, unsubscribeRoom]);

  // Report read position — clears the user-cursor unread badge (contract v1.3).
  useEffect(() => {
    if (!messages) return;
    postConversationRead(`dm:${memberId}`).catch(() => {});
  }, [memberId, messages]);

  // Stick to bottom on new messages while the user is near the bottom.
  useEffect(() => {
    if (nearBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const send = useCallback(
    async (text: string, attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>) => {
      const msg = await sendDmMessage(memberId, text, attachments);
      setMessages((prev) => {
        if (prev?.some((m) => m.id === msg.id)) return prev;
        return [...(prev ?? []), msg];
      });
      nearBottom.current = true;
    },
    [memberId],
  );

  // ── Panel handlers — dm scope writes via the members-shaped scope APIs ──

  const applyScopePatch = useCallback(
    async (patch: Record<string, unknown>, successMsg: string, errorMsg: string) => {
      if (!member) return;
      try {
        const res = await patchMemberScopeConfig(member.memberId, dmScopeId, patch);
        setMember(res.member);
        await refreshMemberInfo(res.member);
        toast(successMsg, "success");
      } catch (err) {
        console.error("Failed to update member config", err);
        const detail = err instanceof Error && err.message ? ` ${err.message}` : "";
        toast(`${errorMsg}${detail}`, "error");
      }
    },
    [member, dmScopeId, refreshMemberInfo, toast],
  );

  const handleSwitchModel = useCallback(
    (model: string | null, credentialId: string | null) =>
      applyScopePatch({ model, credentialId }, `${member?.name} model updated. It applies on the next turn.`, "Couldn’t update the model."),
    [applyScopePatch, member?.name],
  );

  const handleSwitchThinking = useCallback(
    (thinkingLevel: string | null) =>
      applyScopePatch({ thinkingLevel }, `${member?.name} thinking → ${thinkingLevel ?? "default"}`, "Couldn’t update the thinking level."),
    [applyScopePatch, member?.name],
  );

  const handleToggleMcp = useCallback(
    async (server: string) => {
      if (!memberInfo) return;
      const current = new Set(memberInfo.mcpServers || []);
      if (current.has(server)) current.delete(server); else current.add(server);
      const assignableNames = new Set(mcpServers.filter(isAssignableMcpServer).map((s) => s.name));
      const nextServers = mcpServers.map((s) => s.name).filter((name) => current.has(name) && assignableNames.has(name));
      await applyScopePatch({ mcpServers: nextServers }, `${memberInfo.name} tool access saved. Reload the member to apply it.`, "Couldn’t save tool access.");
    },
    [memberInfo, mcpServers, applyScopePatch],
  );

  const handleToggleExtension = useCallback(
    async (extId: string) => {
      if (!memberInfo) return;
      const current = new Set(memberInfo.extensions || []);
      const hit = [...current].find((c) => c === extId || c === `npm:${extId}` || extId.endsWith(c) || c.endsWith(extId));
      if (hit) current.delete(hit);
      else current.add(extId);
      await applyScopePatch({ extensions: Array.from(current) }, `Saved. Reload ${memberInfo.name} to apply extension tools.`, "Couldn’t save extension access.");
    },
    [memberInfo, applyScopePatch],
  );

  const handleRename = useCallback(
    async (name: string) => {
      if (!member) return;
      try {
        const res = await patchGlobalMember(member.memberId, { name });
        setMember(res.member);
        await refreshMemberInfo(res.member);
        toast(`Member renamed: ${member.name} → ${res.member.name}`, "success");
      } catch (err) {
        console.error("Failed to rename member", err);
        toast("Couldn’t rename this member. Check that the name is unique, then try again.", "error");
        throw err;
      }
    },
    [member, refreshMemberInfo, toast],
  );

  const handleCompact = useCallback(async () => {
    try {
      await conversationMemberAction(dmScopeId, memberId, "steer", "/compact");
      toast(`Compact started for ${member?.name}`, "success");
    } catch (err) {
      console.error("Failed to compact member context", err);
      toast("Couldn’t compact this conversation. Try again.", "error");
    }
  }, [dmScopeId, memberId, member?.name, toast]);

  const handleReload = useCallback(async () => {
    try {
      const result = await conversationMemberAction(dmScopeId, memberId, "reload");
      toast(result.message || `${member?.name} reloaded`, result.reloaded ? "success" : "info");
    } catch (err) {
      console.error("Failed to reload member", err);
      toast("Couldn’t apply the latest changes. Try again; restart the member if the problem continues.", "error");
    }
  }, [dmScopeId, memberId, member?.name, toast]);

  const handleResetSession = useCallback(async () => {
    const ok = await confirm(`Reset session for @${member?.name}?\n\nThis clears the member's working session memory and starts fresh. Messages and activity history stay visible.`);
    if (!ok) return;
    try {
      await conversationMemberAction(dmScopeId, memberId, "reset-session");
      toast(`${member?.name} session reset`, "success");
    } catch (err) {
      console.error("Failed to reset member session", err);
      toast("Couldn’t reset this session. Try again.", "error");
    }
  }, [confirm, dmScopeId, memberId, member?.name, toast]);

  // Jump to a specific message (mainline msg refs): scroll + highlight in
  // DOM, or fetch an around-window from the server when not loaded.
  const jumpToMessage = useCallback(async (messageId: string): Promise<void> => {
    const alreadyLoaded = messages?.some((m) => m.id === messageId);
    if (!alreadyLoaded) {
      const window = await getDmMessages(memberId, { around: messageId, limit: PAGE_SIZE }).catch(() => null);
      if (!window || window.messages.length === 0) return;
      setMessages(window.messages);
      setHasMore(true);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = scrollRef.current?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedId(messageId);
      setTimeout(() => setHighlightedId(null), 1500);
    }
  }, [memberId, messages]);

  if (error && !member) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-3">
        <div className="text-center">
          <div className="text-sm font-medium text-ink-2 mb-1">Couldn’t load this member</div>
          <div className="text-xs text-blocked mb-2">{error}</div>
          <button type="button" onClick={onBack} className="text-xs text-accent-ink hover:underline cursor-pointer">Back to contacts</button>
        </div>
      </div>
    );
  }
  if (!member) return <div className="flex-1 flex items-center justify-center text-sm text-ink-3">Loading…</div>;

  const status = session?.status ?? "idle";

  return (
    <div className="flex-1 flex min-h-0 bg-surface-1">
      {/* conversation column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* header — room chat header language; member identity area opens the
            panel ("click the member → panel", same mental model as the room's
            workstation card) */}
        <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            title={`Open ${member.name}'s panel`}
            className="flex items-center gap-2.5 min-w-0 rounded-lg px-2 py-1 -ml-2 hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <StaffBadge name={member.name} status={statusFromAgent(status)} size="sm" />
            <h2 className="text-sm font-semibold tracking-tight text-ink-1 whitespace-nowrap">{member.name}</h2>
            <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{member.agentTemplate}</span>
            <span className="text-[11px] text-ink-4">
              {status === "working" ? <span className="text-onair font-medium">● Working</span> : "Idle"}
            </span>
          </button>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              title="Member panel"
              className={`${toolBtn} ${panelOpen ? "bg-accent-dim text-accent-ink hover:bg-accent-dim hover:text-accent-ink" : ""}`}
            >
              <PanelRight size={13} />
            </button>
          </div>
        </div>

        {/* messages — room chat message language */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto min-w-0 px-4 py-3">
          {!hasMore && messages && messages.length > 0 && (
            <div className="text-center text-xs text-ink-4 py-4">Beginning of conversation</div>
          )}
          {error && <div role="alert" className="text-[12px] text-blocked mb-2">{error}</div>}
          {!messages ? (
            <div className="text-sm text-ink-3 py-8 text-center">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <p className="text-ink-3 text-lg">{member.name}</p>
                <p className="text-ink-4 text-sm mt-1">Say something — everything here activates {member.name} directly</p>
              </div>
            </div>
          ) : (
            <div>
              {messages.map((msg, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const showDateSep = shouldShowDateSeparator(prev, msg);
                const grouped = isGroupedWithPrev(prev, msg);
                const time = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const fullTime = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                const highlighted = highlightedId === msg.id;
                return (
                  <div key={msg.id} data-message-id={msg.id} className={highlighted ? "rounded-lg ring-2 ring-accent/60 bg-accent/5 px-1" : ""}>
                    {showDateSep && <DateSeparator ts={msg.ts} />}
                    <MessageBubble
                      sender={msg.sender}
                      content={msg.content}
                      time={time}
                      fullTime={fullTime}
                      grouped={grouped}
                      isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                      mentions={msg.mentions}
                        members={[member.name]}
                        loginName={getUsername()}
                      roomId={`dm:${memberId}`}
                      messageId={msg.id}
                      attachments={msg.attachments}
                    />
                    {msg.artifacts?.length ? (
                      <MessageArtifactChips messageId={msg.id} artifacts={msg.artifacts} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* composer — room MessageInput; no @ in DM (everything activates the member) */}
        <MessageInput
          onSend={send}
          members={[]}
          draftKey={`dm:${memberId}`}
          hideMentions
          uploadScope={`dm:${memberId}`}
          placeholder={`Message ${member.name}… (no @ needed in DM)`}
          onError={(m) => setError(`Couldn't send. ${m}`)}
        />
      </div>

      {/* member panel — the room's Sheet + MemberConfigPanel, scoped to this DM */}
      {memberInfo && (
        <Sheet open={panelOpen} onClose={() => setPanelOpen(false)} size="xl" dock="right">
          <MemberConfigPanel
            roomId={dmRoomId}
            dmScope={{ scopeId: dmScopeId, memberId: member.memberId }}
            member={memberInfo}
            status={status}
            contextUsage={contextUsage}
            existingMemberNames={[member.name]}
            models={models}
            mcpEnabled={mcpEnabled}
            mcpServers={mcpServers}
            mcpLoadStatus={mcpLoadStatus}
            onRetryMcp={() => {
              setMcpLoadStatus("loading");
              void getMcpSettings()
                .then((s) => { setMcpEnabled(s.enabled); setMcpServers(s.servers || []); setMcpLoadStatus("ready"); })
                .catch(() => setMcpLoadStatus("error"));
            }}
            onOpenMcpSettings={() => { onOpenMcpSettings?.(); setPanelOpen(false); }}
            onClose={() => setPanelOpen(false)}
            onRename={handleRename}
            onSwitchModel={handleSwitchModel}
            onSwitchThinking={handleSwitchThinking}
            onCompact={handleCompact}
            onReload={handleReload}
            onRestart={() => { /* hidden in dm scope — restart needs a dm-safe route (follow-up) */ }}
            onResetSession={handleResetSession}
            onToggleMcp={handleToggleMcp}
            installedExtensions={installedExtensions}
            extensionsLoadStatus={extensionsLoadStatus}
            onRetryExtensions={() => {
              setExtensionsLoadStatus("loading");
              void getExtensions()
                .then((e) => { setInstalledExtensions(e.extensions || []); setExtensionsLoadStatus("ready"); })
                .catch(() => setExtensionsLoadStatus("error"));
            }}
            onToggleExtension={handleToggleExtension}
            onOpenExtensionsSettings={() => { onOpenExtensionsSettings?.(); setPanelOpen(false); }}
            onJumpToMessage={jumpToMessage}
          />
        </Sheet>
      )}
    </div>
  );
}
