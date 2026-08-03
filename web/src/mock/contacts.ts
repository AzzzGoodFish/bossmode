/**
 * TEMPORARY frontend-first mock (0.20 member-global model).
 *
 * These shapes mirror the planned API contracts (global unique member, per-scope
 * sessions, 4-layer memory). Backend will expose the same shapes — swap these
 * imports for api/client calls when the API lands. Marked mock so it can never
 * be mistaken for production data: the directory is labeled in-page as well.
 */

export type MemberStatus = "working" | "idle" | "offline";

export interface MemberScopeRef {
  kind: "dm" | "room";
  /** room scopes only */
  roomId?: string;
  roomName?: string;
}

export interface MemberContact {
  /** Globally unique system id (internal concept, reserved for future use). */
  id: string;
  /** Globally unique display name — routing key. */
  name: string;
  /** Bound agent template (identity prompt source). */
  template: string;
  description: string;
  status: MemberStatus;
  /** Label of the scope the member is currently working in (when working). */
  activeScope?: string;
  /** Effective model label (global config, or scope override when split). */
  model: string;
  /** Unified config switches — when on, all scopes inherit the global config. */
  unified: { model: boolean; extensions: boolean };
  /** Context usage of the member's busiest scope, 0–100. */
  contextPct: number;
  /** Lifetime tokens across all scopes (input + output + cache). */
  tokenTotal: number;
  scopes: MemberScopeRef[];
}

export interface DmMessage {
  id: string;
  from: "user" | "member";
  text: string;
  ts: number;
}

export const MOCK_MEMBERS: MemberContact[] = [
  {
    id: "m-01",
    name: "pm",
    template: "pm",
    description: "Organizes work, tracks delivery, keeps the room aligned.",
    status: "idle",
    model: "claude-sonnet-4.6",
    unified: { model: true, extensions: true },
    contextPct: 62,
    tokenTotal: 594_608_449,
    scopes: [
      { kind: "dm" },
      { kind: "room", roomId: "bff2", roomName: "bossmode dev" },
      { kind: "room", roomId: "vul1", roomName: "vulnhunt srv" },
    ],
  },
  {
    id: "m-02",
    name: "architect",
    template: "architect",
    description: "System design, root-cause analysis, merge & release gates.",
    status: "working",
    activeScope: "bossmode dev",
    model: "claude-fable-5",
    unified: { model: true, extensions: true },
    contextPct: 84,
    tokenTotal: 744_463_978,
    scopes: [
      { kind: "dm" },
      { kind: "room", roomId: "bff2", roomName: "bossmode dev" },
    ],
  },
  {
    id: "m-03",
    name: "developer",
    template: "developer",
    description: "Implements features and fixes, runs builds and packs releases.",
    status: "working",
    activeScope: "vulnhunt srv",
    model: "k3-256k",
    unified: { model: false, extensions: true },
    contextPct: 41,
    tokenTotal: 1_364_998_454,
    scopes: [
      { kind: "dm" },
      { kind: "room", roomId: "bff2", roomName: "bossmode dev" },
      { kind: "room", roomId: "vul1", roomName: "vulnhunt srv" },
    ],
  },
  {
    id: "m-04",
    name: "dev-ben",
    template: "developer",
    description: "Second development stream for parallel delivery.",
    status: "idle",
    model: "claude-sonnet-4.6",
    unified: { model: true, extensions: true },
    contextPct: 18,
    tokenTotal: 706_157_800,
    scopes: [{ kind: "dm" }, { kind: "room", roomId: "bff2", roomName: "bossmode dev" }],
  },
  {
    id: "m-05",
    name: "qa",
    template: "qa",
    description: "Acceptance testing, migration rehearsal, release sign-off.",
    status: "idle",
    model: "claude-sonnet-4.6",
    unified: { model: true, extensions: true },
    contextPct: 33,
    tokenTotal: 632_031_099,
    scopes: [{ kind: "dm" }, { kind: "room", roomId: "bff2", roomName: "bossmode dev" }],
  },
  {
    id: "m-06",
    name: "designer",
    template: "designer",
    description: "Turns requirements into visual reality — owns look, feel, words.",
    status: "working",
    activeScope: "bossmode dev",
    model: "claude-sonnet-4.6",
    unified: { model: true, extensions: true },
    contextPct: 47,
    tokenTotal: 262_688_322,
    scopes: [{ kind: "dm" }, { kind: "room", roomId: "bff2", roomName: "bossmode dev" }],
  },
];

export const MOCK_DM_MESSAGES: Record<string, DmMessage[]> = {
  "m-01": [
    { id: "d1", from: "user", text: "@pm 0.19.6 发版后我们聊聊 0.20 的规划", ts: Date.now() - 1000 * 60 * 42 },
    { id: "d2", from: "member", text: "好。0.20 我先盘一下要动的面：member 全局化、contacts 中心、记忆四层，你定方向我来拆。", ts: Date.now() - 1000 * 60 * 40 },
    { id: "d3", from: "user", text: "核心是把 member 做成真正的数字员工", ts: Date.now() - 1000 * 60 * 38 },
    { id: "d4", from: "member", text: "同意。那 contacts 就是产品中心——先建人，再拉进各个 scope 干活。我出一版功能规格？", ts: Date.now() - 1000 * 60 * 35 },
  ],
  "m-06": [
    { id: "d1", from: "user", text: "favicon 做完了吗", ts: Date.now() - 1000 * 60 * 66 },
    { id: "d2", from: "member", text: "好了——teal 圆角方块 + 白 B，取产品 accent。SVG + 32px PNG + 180px touch icon 都出了，预览在 13005。", ts: Date.now() - 1000 * 60 * 64 },
  ],
};

export function getMember(id: string): MemberContact | undefined {
  return MOCK_MEMBERS.find((m) => m.id === id || m.name === id);
}

export function getDmMessages(memberId: string): DmMessage[] {
  return MOCK_DM_MESSAGES[memberId] ?? [
    { id: "seed", from: "member", text: "我在。这个 scope 是我们的私聊——记忆全局共享，说正事就行。", ts: Date.now() - 1000 * 60 * 5 },
  ];
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "k";
  return String(n);
}
