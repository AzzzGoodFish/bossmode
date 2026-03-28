import { useState, useEffect, useCallback } from "react";
import type { Room } from "../api/client";
import {
  createRoom as apiCreateRoom,
  steerAgent as apiSteerAgent,
  archiveRoom as apiArchiveRoom,
  addMember as apiAddMember,
} from "../api/client";
import { useWebSocket } from "../hooks/useWebSocket";
import { useRoom } from "../hooks/useRoom";
import { ChatArea } from "../components/ChatArea";
import { MemberPanel } from "../components/MemberPanel";
import { MessageInput } from "../components/MessageInput";
import { CreateRoomDialog } from "../components/CreateRoomDialog";
import { AgentTab, type CommittedEvent } from "../components/AgentTab";
import { AddMemberDialog } from "../components/AddMemberDialog";

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
}

export function Main({ selectedRoomId, onSelectRoom, onRoomCreated, username, externalShowCreateRoom, onCreateRoomShown }: MainProps) {
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);

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
    loading,
    hasMore,
    loadingOlder,
    loadOlder,
    sendMessage,
    handleWsEvent,
    reloadRoom,
  } = useRoom(selectedRoomId);

  const { connected, reconnecting, subscribeRoom, unsubscribeRoom } = useWebSocket({
    onEvent: handleWsEvent,
  });

  useEffect(() => {
    if (selectedRoomId) {
      subscribeRoom(selectedRoomId);
      return () => unsubscribeRoom(selectedRoomId);
    }
  }, [selectedRoomId, subscribeRoom, unsubscribeRoom]);

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

  const openAgentTab = useCallback((agentName: string) => {
    setTabs((prev) => {
      const existingIdx = prev.findIndex((t) => t.type === "agent" && t.agentName === agentName);
      if (existingIdx !== -1) {
        setActiveTabIdx(existingIdx);
        return prev;
      }
      const newTabs = [...prev, { type: "agent" as const, agentName }];
      setActiveTabIdx(newTabs.length - 1);
      return newTabs;
    });
  }, []);

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
    async (name: string, cwd: string, members: string[], knowledgeBaseId?: string, ruleIds?: string[]) => {
      try {
        const newRoom = await apiCreateRoom(name, cwd, members, knowledgeBaseId, ruleIds);
        onRoomCreated(newRoom);
        setShowCreateRoom(false);
      } catch (err: any) {
        alert(err.message);
      }
    },
    [onRoomCreated],
  );

  const handleAgentEventsChange = useCallback((events: CommittedEvent[]) => {
    const tab = tabs[activeTabIdx];
    if (tab?.type === "agent" && tab.agentName) {
      setAgentEventsCache((prev) => ({ ...prev, [tab.agentName!]: events }));
    }
  }, [tabs, activeTabIdx]);

  const handleArchive = useCallback(async () => {
    if (!selectedRoomId) return;
    if (!confirm("Archive old messages? Last 50 will be kept.")) return;
    try {
      const result = await apiArchiveRoom(selectedRoomId);
      if (result.archivedCount === 0) {
        alert("Nothing to archive (less than 50 messages).");
      } else {
        alert(`Archived ${result.archivedCount} messages.`);
        await reloadRoom();
      }
    } catch (err: any) {
      alert(`Archive failed: ${err.message}`);
    }
  }, [selectedRoomId, reloadRoom]);

  const handleAddMember = useCallback(async (agentName: string) => {
    if (!selectedRoomId) return;
    try {
      await apiAddMember(selectedRoomId, agentName);
      await reloadRoom();
    } catch (err: any) {
      alert(`Failed to add member: ${err.message}`);
    }
  }, [selectedRoomId, reloadRoom]);

  const activeTab = tabs[activeTabIdx];

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
      {/* Tab bar */}
      <div className="h-9 border-b border-zinc-200 dark:border-zinc-800 flex items-end px-2 shrink-0 gap-0.5">
        {tabs.map((tab, idx) => {
          const isActive = idx === activeTabIdx;
          const label = tab.type === "room" ? `# ${room.name}` : tab.agentName!;
          return (
            <button
              key={tab.type === "room" ? "room" : tab.agentName}
              onClick={() => setActiveTabIdx(idx)}
              className={`group flex items-center gap-1 px-3 py-1.5 text-xs rounded-t transition-colors cursor-pointer ${
                isActive ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white" : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50"
              }`}
            >
              <span className="truncate max-w-24">{label}</span>
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
            <button onClick={handleArchive} className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors cursor-pointer">Archive</button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          {activeTab?.type === "room" ? (
            <>
              <ChatArea messages={messages} roomName={room.name} hasMore={hasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />
              <MessageInput onSend={sendMessage} members={room.members} disabled={loading} />
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
        <div className="w-48 border-l border-zinc-200 dark:border-zinc-800 shrink-0">
          <MemberPanel
            members={room.members}
            agentStatus={agentStatus}
            onOpenPrivateChat={openAgentTab}
          />
        </div>
      </div>

      {showCreateRoom && (
        <CreateRoomDialog onClose={() => setShowCreateRoom(false)} onSubmit={handleCreateRoom} />
      )}
      {showAddMember && (
        <AddMemberDialog currentMembers={room.members} onAdd={handleAddMember} onClose={() => setShowAddMember(false)} />
      )}
    </>
  );
}
