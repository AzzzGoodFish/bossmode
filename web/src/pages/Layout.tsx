import { useState, useCallback } from "react";
import type { Room } from "../api/client";
import { Sidebar, type ActivePage } from "../components/Sidebar";
import { Main } from "./Main";
import { AgentDetailPage } from "./AgentDetailPage";
import { SkillDetailPage } from "./SkillDetailPage";
import { KnowledgePage } from "./KnowledgePage";
import { MembersPage } from "./MembersPage";
import { SettingsPage } from "./SettingsPage";

interface LayoutProps {
  onLogout: () => void;
  username: string;
}

export function Layout({ onLogout, username }: LayoutProps) {
  const [activePage, setActivePage] = useState<ActivePage>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshSidebar = useCallback(() => setRefreshKey((k) => k + 1), []);

  const handleRoomCreated = useCallback((room: Room) => {
    setActivePage({ type: "room", id: room.id });
    refreshSidebar();
  }, [refreshSidebar]);

  return (
    <div className="h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-white flex" data-1p-ignore>
      <Sidebar
        activePage={activePage}
        username={username}
        onNavigate={setActivePage}
        onLogout={onLogout}
        refreshKey={refreshKey}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Room view */}
        {activePage?.type === "room" && activePage.id !== "__new__" && (
          <Main
            selectedRoomId={activePage.id}
            onSelectRoom={(id) => setActivePage({ type: "room", id })}
            onRoomCreated={handleRoomCreated}
            username={username}
          />
        )}

        {/* Room creation (triggered by sidebar +) */}
        {activePage?.type === "room" && activePage.id === "__new__" && (
          <Main
            selectedRoomId={null}
            onSelectRoom={(id) => setActivePage({ type: "room", id })}
            onRoomCreated={handleRoomCreated}
            username={username}
            externalShowCreateRoom={true}
            onCreateRoomShown={() => {}}
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
          <KnowledgePage
            selectedKbId={activePage.id}
            selectedEntryId={(activePage as any).entryId}
            onSelectKb={(id) => setActivePage({ type: "knowledge", id })}
            onSelectEntry={(kbId, entryId, entryTitle) => setActivePage({ type: "knowledge", id: kbId, entryId, entryTitle } as any)}
          />
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

        {/* Empty state */}
        {!activePage && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <p className="text-zinc-400 dark:text-zinc-500 text-lg">Welcome to Bossmode</p>
              <p className="text-zinc-400 dark:text-zinc-600 text-sm mt-1">Select an item from the sidebar</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
