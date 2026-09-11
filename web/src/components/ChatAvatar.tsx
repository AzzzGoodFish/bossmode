import type { CSSProperties } from "react";
import { Users } from "lucide-react";

const COLORS = [
  "#9d8cff",
  "#79a9eb",
  "#d2a348",
  "#7cbcab",
  "#e37bb8",
  "#77b9bd",
];
export function identityColor(identity: string): string {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}
export function memberStateLabel(status?: string): string {
  switch (status) {
    case "working":
      return "正在工作";
    case "thinking":
      return "思考中";
    case "idle":
      return "空闲";
    case "error":
    case "blocked":
      return "需要处理";
    case "off":
    case "inactive":
      return "未启动";
    default:
      return "状态未知";
  }
}
export function ChatAvatar({
  name,
  identity,
  size = "md",
  status,
  room = false,
  user = false,
}: {
  name: string;
  identity?: string;
  size?: "sm" | "md" | "lg";
  status?: string;
  room?: boolean;
  user?: boolean;
}) {
  return (
    <span
      className={`bm-avatar bm-avatar-${size}${room ? " bm-avatar-room" : ""}${status === "working" ? " is-working" : ""}`}
      style={
        {
          "--identity": user
            ? "var(--avatar-user)"
            : identityColor(identity || name),
        } as CSSProperties
      }
      aria-hidden="true"
    >
      {room ? (
        <Users size={size === "lg" ? 30 : 19} />
      ) : (
        <span className="bm-avatar-letter">{name.charAt(0).toUpperCase()}</span>
      )}
      {status && <span className={`bm-avatar-status state-${status}`} />}
    </span>
  );
}
