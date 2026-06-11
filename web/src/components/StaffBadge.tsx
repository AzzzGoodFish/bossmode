/**
 * StaffBadge — 员工工牌：头像 + 状态环。
 * 产品签名组件：同一颗组件出现在侧栏、工位墙、聊天头像、任务 assignee。
 * 状态环颜色 = 状态（working 绿呼吸 / thinking 琥珀呼吸 / blocked 红 / idle 灰 / boss 署名色）。
 */

export type BadgeStatus = "working" | "thinking" | "idle" | "blocked" | "offline" | "boss";

const RING_CLASS: Record<BadgeStatus, string> = {
  working: "ring-onair",
  thinking: "ring-think",
  blocked: "ring-blocked",
  boss: "ring-boss",
  idle: "",
  offline: "",
};

const SIZE = {
  xs: { box: "w-5 h-5", text: "text-[9px]" },
  sm: { box: "w-6 h-6", text: "text-[10px]" },
  md: { box: "w-8 h-8", text: "text-xs" },
  lg: { box: "w-14 h-14", text: "text-xl" },
} as const;

export function statusFromAgent(status?: string): BadgeStatus {
  switch (status) {
    case "working": return "working";
    case "thinking": return "thinking";
    case "idle": return "idle";
    default: return "offline";
  }
}

export function StaffBadge({
  name,
  status = "idle",
  size = "md",
  avatar,
  className = "",
}: {
  name: string;
  status?: BadgeStatus;
  size?: keyof typeof SIZE;
  avatar?: string;
  className?: string;
}) {
  const s = SIZE[size];
  const ring = RING_CLASS[status];
  return (
    <div className={`badge-ring ${ring} ${s.box} shrink-0 ${className}`} title={name}>
      <div
        className={`${s.box} rounded-full flex items-center justify-center font-semibold select-none ${
          status === "boss"
            ? "bg-accent-dim text-accent-ink"
            : "bg-surface-3 text-ink-2"
        } ${s.text}`}
      >
        {avatar ? <span>{avatar}</span> : name.charAt(0).toUpperCase()}
      </div>
    </div>
  );
}
