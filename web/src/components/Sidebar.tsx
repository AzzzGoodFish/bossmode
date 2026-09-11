import { conversationTime } from "../utils/conversation-time";
import { useMemberProfileRevision } from "../hooks/useMemberProfileRevision";
import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  LogOut,
  Settings,
  Sun,
  Moon,
  Loader2,
  Plus,
  UserPlus,
  Search,
  BookOpen,
  ChevronDown,
  ArrowLeft,
  X,
  Users,
  Sparkles,
} from "lucide-react";
import {
  createGlobalMember,
  getRooms,
  getChats,
  getContacts,
  type Room,
  type ChatEntry,
  type ContactEntry,
} from "../api/client";
import { ChatAvatar } from "./ChatAvatar";

export type SettingsSection = "models" | "runtime" | "prompt" | "usage";
export type ActivePage =
  | { type: "chats" }
  | { type: "dm"; memberId: string }
  | { type: "room"; id: string }
  | { type: "library" }
  | { type: "settings"; section?: SettingsSection }
  | null;
export function domainOf(page: ActivePage): "chats" | "system" {
  return page?.type === "settings" ? "system" : "chats";
}
interface SidebarProps {
  activePage: ActivePage;
  username: string;
  onNavigate: (page: ActivePage) => void;
  onLogout: () => void;
  refreshKey?: number;
  unreadRoomIds?: Set<string>;
  onRoomsLoaded?: (rooms: Room[]) => void;
  liveRooms?: Room[];
  liveStatuses?: ReadonlyMap<string, string>;
  collapsed: boolean;
  onToggle: () => void;
  onReplayTour?: () => void;
}
const SECTIONS: Array<{ id: SettingsSection; title: string; desc: string }> = [
  { id: "models", title: "模型", desc: "连接服务，选择可用模型" },
  { id: "runtime", title: "运行设置", desc: "会话与连接恢复" },
  { id: "prompt", title: "系统提示词", desc: "所有成员共用的规则" },
  { id: "usage", title: "用量", desc: "按成员、房间和时间查看" },
];
export function Sidebar({
  activePage,
  username,
  onNavigate,
  onLogout,
  refreshKey,
  onRoomsLoaded,
  unreadRoomIds,
  onReplayTour,
  liveStatuses,
}: SidebarProps) {
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [chats, setChats] = useState<ChatEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<"new" | "account" | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [people, setPeople] = useState<ContactEntry[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reduced, setReduced] = useState(
    () => localStorage.getItem("bossmode_reduced_motion") === "true",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const profileRevision = useMemberProfileRevision();
  const settings = activePage?.type === "settings";

  useEffect(() => {
    let stopped = false;
    const load = () =>
      Promise.all([getRooms(), getChats()])
        .then(([nextRooms, nextChats]) => {
          if (stopped) return;
          setRooms(nextRooms);
          setChats(nextChats.chats);
          setLoadError(false);
        })
        .catch(() => {
          if (!stopped) setLoadError(true);
        });
    void load();
    const timer = window.setInterval(load, 8000);
    const refresh = () => void load();
    window.addEventListener("bossmode:conversations-changed", refresh);
    (window as any).__bossmode_refreshSidebar = refresh;
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("bossmode:conversations-changed", refresh);
    };
  }, [refreshKey, profileRevision]);
  useEffect(() => {
    if (rooms === null) return;
    onRoomsLoaded?.(rooms);
    (window as any).__bossmode_rooms = rooms;
  }, [rooms, onRoomsLoaded]);
  useEffect(() => {
    document.documentElement.classList.toggle("bm-reduce-motion", reduced);
    localStorage.setItem("bossmode_reduced_motion", String(reduced));
  }, [reduced]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (!menu) return;
    if (menu === "new")
      getContacts()
        .then((r) => setPeople(r.contacts))
        .catch(() => setError("暂时无法加载成员，请重新打开试试。"));
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        triggerRef.current?.focus();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>(
          "input,button:not([disabled])",
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0);
      const first = items[0],
        last = items[items.length - 1];
      if (!first) {
        e.preventDefault();
        return;
      }
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          !menuRef.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        last.focus();
      }
      if (
        !e.shiftKey &&
        (document.activeElement === last ||
          !menuRef.current?.contains(document.activeElement))
      ) {
        e.preventDefault();
        first.focus();
      }
    };
    const pointer = (e: PointerEvent) => {
      if (
        !menuRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      )
        setMenu(null);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", pointer);
    const focus = window.setTimeout(
      () =>
        menuRef.current?.querySelector<HTMLElement>("input,button")?.focus(),
      30,
    );
    return () => {
      clearTimeout(focus);
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", pointer);
    };
  }, [menu]);
  const open = (kind: "new" | "account", button: HTMLButtonElement) => {
    triggerRef.current = button;
    setAnchor(button.getBoundingClientRect());
    setError(null);
    setMemberQuery("");
    setMenu(menu === kind ? null : kind);
  };
  const navigate = (page: ActivePage) => {
    setMenu(null);
    onNavigate(page);
  };
  const sorted = useMemo(
    () =>
      [...(chats ?? [])].sort(
        (a, b) => (b.lastMessage?.ts ?? 0) - (a.lastMessage?.ts ?? 0),
      ),
    [chats],
  );
  const visible = sorted.filter((c) =>
    c.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const createMember = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createGlobalMember({});
      navigate({ type: "dm", memberId: result.member.memberId });
      window.dispatchEvent(new Event("bossmode:conversations-changed"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const choose = (c: ChatEntry) => {
    if (c.kind === "dm" && c.memberId)
      navigate({ type: "dm", memberId: c.memberId });
    else if (c.roomId) navigate({ type: "room", id: c.roomId });
  };
  const menuWidth = 286;
  const menuStyle = anchor
    ? {
        width: Math.min(menuWidth, window.innerWidth - 24),
        left: Math.max(
          12,
          Math.min(anchor.left, window.innerWidth - menuWidth - 12),
        ),
        ...(menu === "account"
          ? { bottom: Math.max(12, window.innerHeight - anchor.top + 9) }
          : { top: anchor.bottom + 9 }),
      }
    : {};
  return (
    <aside className="bm-sidebar" aria-label="会话导航">
      <div className="bm-brand-row">
        <span className="bm-mark" aria-hidden="true">
          B
        </span>
        <span className="bm-brand">bossmode</span>
        <button
          className="bm-new"
          title="新建聊天"
          aria-label="新建聊天"
          aria-expanded={menu === "new"}
          data-tour="new-room"
          onClick={(e) => open("new", e.currentTarget)}
        >
          <Plus size={18} />
        </button>
      </div>
      <label className="bm-search">
        <Search size={16} />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && visible[0]) {
              choose(visible[0]);
              setQuery("");
            }
          }}
          placeholder="搜索会话"
          aria-label="搜索会话"
        />
        <span className="bm-key">
          {navigator.platform.toLowerCase().includes("mac") ? "⌘ K" : "Ctrl K"}
        </span>
      </label>
      <div className="bm-list-label">
        <span>{settings ? "设置" : "会话"}</span>
        {settings && (
          <button
            aria-label="返回聊天"
            onClick={() => {
              const target =
                sorted.find(
                  (c) =>
                    c.scopeId ===
                    localStorage.getItem("bossmode_last_conversation"),
                ) ?? sorted[0];
              if (target) choose(target);
              else navigate({ type: "chats" });
            }}
          >
            <ArrowLeft size={14} />
          </button>
        )}
      </div>
      <div className="bm-chats">
        {settings ? (
          SECTIONS.map((section) => (
            <button
              className={`bm-setting-link ${activePage.section === section.id || (!activePage.section && section.id === "models") ? "is-selected" : ""}`}
              key={section.id}
              onClick={() =>
                navigate({ type: "settings", section: section.id })
              }
            >
              <strong>{section.title}</strong>
              <span>{section.desc}</span>
            </button>
          ))
        ) : (
          <>
            {loadError && (
              <p className="bm-list-empty" role="alert">
                会话暂时加载失败，正在重试。
              </p>
            )}
            {!chats && !loadError && (
              <p className="bm-list-empty">正在加载会话…</p>
            )}
            {chats && !visible.length && (
              <p className="bm-list-empty">
                {query ? "没有匹配的会话" : "还没有会话，点上方＋开始。"}
              </p>
            )}
            {visible.map((c) => {
              const selected =
                c.kind === "dm"
                  ? activePage?.type === "dm" &&
                    activePage.memberId === c.memberId
                  : activePage?.type === "room" && activePage.id === c.roomId;
              const unread =
                c.unreadCount > 0 ||
                (!!c.roomId && unreadRoomIds?.has(c.roomId));
              return (
                <button
                  key={c.scopeId}
                  data-conversation={c.scopeId}
                  aria-current={selected ? "page" : undefined}
                  className={`bm-chat-row ${selected ? "is-selected" : ""}`}
                  onClick={() => choose(c)}
                >
                  <ChatAvatar
                    name={c.title}
                    identity={c.memberId || c.roomId}
                    room={c.kind === "room"}
                    status={
                      c.kind === "dm"
                        ? (liveStatuses?.get(`${c.scopeId}:${c.memberId}`) ??
                          c.status)
                        : undefined
                    }
                  />
                  <span className="bm-chat-copy">
                    <span className="bm-chat-top">
                      <span className="bm-chat-name">{c.title}</span>
                      {c.lastMessage && (
                        <time className="bm-chat-time">
                          {conversationTime(c.lastMessage.ts)}
                        </time>
                      )}
                    </span>
                    <span className="bm-chat-preview">
                      {c.lastMessage
                        ? c.lastMessage.text.replace(/\s+/g, " ")
                        : "暂无消息"}
                    </span>
                  </span>
                  {unread && (
                    <span className="bm-unread" aria-label="未读消息">
                      {c.mentioned
                        ? "@"
                        : c.unreadCount > 99
                          ? "99+"
                          : c.unreadCount || ""}
                    </span>
                  )}
                </button>
              );
            })}
          </>
        )}
      </div>
      <div className="bm-side-footer">
        <button
          className="bm-library-btn"
          onClick={() => navigate({ type: "library" })}
        >
          <BookOpen size={17} />
          文档库
        </button>
        <button
          className="bm-account"
          aria-expanded={menu === "account"}
          aria-label={`${username}，打开菜单`}
          onClick={(e) => open("account", e.currentTarget)}
        >
          <ChatAvatar name={username} user size="sm" />
          <span>{username}</span>
          <ChevronDown size={15} />
        </button>
        {import.meta.env.VITE_BOSSMODE_ENV_LABEL && (
          <span className="bm-environment-label">
            {import.meta.env.VITE_BOSSMODE_ENV_LABEL}
          </span>
        )}
      </div>
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label={menu === "new" ? "新建聊天" : "账户菜单"}
            className="bm-popover"
            style={menuStyle}
          >
            {menu === "new" ? (
              <>
                <label className="bm-pop-search">
                  <Search size={15} />
                  <input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder="找一位成员"
                    aria-label="查找成员"
                  />
                </label>
                <button
                  className="bm-pop-action"
                  disabled={busy}
                  onClick={() => void createMember()}
                >
                  {busy ? (
                    <Loader2 className="animate-spin" size={16} />
                  ) : (
                    <UserPlus size={16} />
                  )}
                  创建成员
                </button>
                <button
                  className="bm-pop-action"
                  onClick={() => navigate({ type: "room", id: "__new__" })}
                >
                  <Users size={16} />
                  创建房间
                </button>
                <div className="bm-menu-divider" />
                <div className="bm-pop-label">和成员聊聊</div>
                {people
                  .filter((m) =>
                    (m.name + " " + (m.title || ""))
                      .toLowerCase()
                      .includes(memberQuery.toLowerCase()),
                  )
                  .map((m) => (
                    <button
                      className="bm-person-item"
                      key={m.memberId}
                      onClick={() =>
                        navigate({ type: "dm", memberId: m.memberId })
                      }
                    >
                      <ChatAvatar
                        name={m.name}
                        identity={m.memberId}
                        size="sm"
                      />
                      <span>
                        <strong>{m.name}</strong>
                        <small>{m.title || "成员"}</small>
                      </span>
                    </button>
                  ))}
              </>
            ) : (
              <>
                <div className="bm-menu-identity">
                  <strong>{username}</strong>
                  <span>Bossmode</span>
                </div>
                <button
                  className="bm-pop-action"
                  data-tour="settings"
                  onClick={() => navigate({ type: "settings" })}
                >
                  <Settings size={16} />
                  设置
                </button>
                <button
                  className="bm-pop-action"
                  onClick={() => {
                    const dark =
                      document.documentElement.classList.toggle("dark");
                    localStorage.setItem(
                      "bossmode_theme",
                      dark ? "dark" : "light",
                    );
                  }}
                >
                  <Sun size={16} className="hidden dark:block" />
                  <Moon size={16} className="block dark:hidden" />
                  切换深浅外观
                </button>
                <button
                  className="bm-pop-action"
                  role="switch"
                  aria-checked={reduced}
                  onClick={() => setReduced((v) => !v)}
                >
                  <Sparkles size={16} />
                  减少动态效果
                  <span className={`bm-switch ${reduced ? "is-on" : ""}`} />
                </button>
                {onReplayTour && (
                  <button
                    className="bm-pop-action"
                    data-tour="help"
                    onClick={() => {
                      setMenu(null);
                      onReplayTour();
                    }}
                  >
                    <BookOpen size={16} />
                    使用引导
                  </button>
                )}
                <div className="bm-menu-divider" />
                <button className="bm-pop-action" onClick={onLogout}>
                  <LogOut size={16} />
                  退出登录
                </button>
              </>
            )}
            {error && (
              <p className="bm-pop-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="bm-pop-close"
              aria-label="关闭菜单"
              onClick={() => {
                setMenu(null);
                triggerRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </div>,
          document.body,
        )}
    </aside>
  );
}
