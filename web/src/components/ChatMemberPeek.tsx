import { useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  AtSign,
  UserRound,
  SlidersHorizontal,
  Activity,
  ChevronRight,
  X,
} from "lucide-react";
import { getMemberDetail, type MemberDetail } from "../api/client";
import { useMemberProfileRevision } from "../hooks/useMemberProfileRevision";
import { useMemberFloat } from "./member-float";
import { ChatAvatar, memberStateLabel } from "./ChatAvatar";

export function ChatMemberPeek({
  memberId,
  scopeId,
  status,
  onClose,
  onOpenDm,
  onMention,
}: {
  memberId: string;
  scopeId: string;
  status?: string;
  onClose: () => void;
  onOpenDm?: (id: string) => void;
  onMention?: (name: string) => void;
}) {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [error, setError] = useState(false);
  const float = useMemberFloat();
  const revision = useMemberProfileRevision(memberId);
  const initialFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    initialFocus.current = document.activeElement as HTMLElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (initialFocus.current?.isConnected)
        initialFocus.current.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    setMember(null);
    setError(false);
    getMemberDetail(memberId)
      .then((m) => {
        if (!stopped) setMember(m);
      })
      .catch(() => {
        if (!stopped) setError(true);
      });
    return () => {
      stopped = true;
    };
  }, [memberId, revision, float.saveVersions[memberId]]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !document.querySelector(
          '[data-member-float],[aria-modal="true"],.bm-popover,.bm-header-menu',
        )
      )
        onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <aside
      className="bm-detail"
      aria-label="成员详情"
      data-member-peek={memberId}
    >
      <div className="bm-detail-head">
        <span>成员详情</span>
        <button
          ref={closeRef}
          className="bm-icon-btn"
          onClick={onClose}
          aria-label="关闭成员详情"
        >
          <X size={17} />
        </button>
      </div>
      {!member ? (
        <p className="bm-detail-note" role={error ? "alert" : "status"}>
          {error ? "暂时无法加载成员详情，请重新打开试试。" : "正在加载…"}
        </p>
      ) : (
        <>
          <div className="bm-detail-identity">
            <ChatAvatar
              name={member.name}
              identity={memberId}
              status={status}
              size="lg"
            />
            <h2>{member.name}</h2>
            {member.title && <p>{member.title}</p>}
            <div className="bm-detail-status">
              <span className={`bm-state-dot state-${status || "unknown"}`} />
              {memberStateLabel(status)}
            </div>
            <div className="bm-detail-actions">
              {onOpenDm && (
                <button
                  className="bm-btn soft"
                  onClick={() => onOpenDm(memberId)}
                >
                  <MessageCircle size={15} />
                  发私聊
                </button>
              )}
              {onMention && (
                <button
                  className="bm-btn"
                  onClick={() => onMention(member.name)}
                >
                  <AtSign size={15} />
                  提及
                </button>
              )}
            </div>
          </div>
          <div className="bm-detail-section">
            <h3>当前会话</h3>
            <button
              className="bm-detail-config"
              onClick={() => float.open(memberId, scopeId, "activity")}
            >
              <span>
                <Activity size={16} />
                查看活动
              </span>
              <ChevronRight size={14} />
            </button>
            {member.global?.model && (
              <p className="bm-detail-model" title={member.global.model}>
                {member.global.model}
              </p>
            )}
          </div>
          <div className="bm-detail-section">
            <button
              className="bm-detail-config"
              onClick={() => float.open(memberId, scopeId, "profile")}
            >
              <span>
                <UserRound size={16} />
                资料与偏好
              </span>
              <ChevronRight size={14} />
            </button>
            <button
              className="bm-detail-config"
              onClick={() => float.open(memberId, scopeId, "settings")}
            >
              <span>
                <SlidersHorizontal size={16} />
                模型、会话与资源
              </span>
              <ChevronRight size={14} />
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
