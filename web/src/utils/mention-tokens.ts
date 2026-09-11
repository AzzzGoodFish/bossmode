/**
 * Mention token splitting + two-tier pills (mention-highlight v2; updated
 * 2026-09-11 — the `!name` urgent gesture and its blocked-red tier retired).
 *
 * Tiers (existing tokens only, zero new):
 * - `@member` queued activation → accent pill
 * - `@<loginName>` (@me, same judgement as unread mentioned) → amber pill
 *
 * Rules mirror the backend parser: only real member names are tinted (an @
 * followed by a non-member is plain text); code spans/links are excluded by
 * the callers (the remark plugin never visits them; the plain-text path has no
 * code concept).
 */

export type MentionTier = "member" | "self";

export interface MentionTokenPart {
  text: string;
  tier?: MentionTier;
}

export const MENTION_PILL_CLASSES: Record<MentionTier, string> = {
  member: "bg-accent-dim text-accent-ink rounded px-[3px] py-px font-medium",
  self: "bg-think-dim text-think rounded px-[3px] py-px font-semibold",
};

const LEGAL_NAME_CHAR = "[\\w.-]";

/**
 * Strip markdown code segments (inline `…` + fenced blocks) as same-length
 * whitespace — offsets stay stable so match ranges map back to the original
 * text. Mirror of src/shared/mention-text.ts (web cannot import src/shared);
 * parity is locked by tests. Code is literal text: a backticked @ never tints.
 */
export function stripCodeSegments(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (m) => " ".repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MentionTokenOptions {
  /** Names eligible for highlighting — persisted mention snapshot, or the room roster fallback, plus the user's login name. */
  names: string[];
  /** Human user's login name → "self" (amber) tier for `@<loginName>`. */
  loginName?: string | null;
}

/**
 * Split text into plain and mention parts. A token is `@name`; membership
 * decides whether it tints at all, the login name decides the self tier.
 */
export function splitMentionTokens(content: string, opts: MentionTokenOptions): MentionTokenPart[] {
  if (!content) return [];
  const names = [...new Set(opts.names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ text: content }];
  const loginName = opts.loginName || undefined;

  const scan = stripCodeSegments(content);
  const nameAlt = names.map(escapeRegex).join("|");
  const atRe = `(@)(${nameAlt})(?!${LEGAL_NAME_CHAR})`;
  const matcher = new RegExp(atRe, "g");

  const parts: MentionTokenPart[] = [];
  let cursor = 0;
  for (let match = matcher.exec(scan); match; match = matcher.exec(scan)) {
    const name = match[2] as string;
    const tokenStart = match.index;
    if (tokenStart > cursor) parts.push({ text: content.slice(cursor, tokenStart) });
    const tier: MentionTier = loginName && name === loginName ? "self" : "member";
    parts.push({ text: `@${name}`, tier });
    cursor = match.index + match[0].length;
  }
  if (cursor < content.length) parts.push({ text: content.slice(cursor) });
  return parts.length ? parts : [{ text: content }];
}

/**
 * Resolve the highlight name set for a message: persisted mention snapshots
 * when present (only members the router actually activated tint), the room
 * roster as fallback when no snapshot exists, plus the user's login name.
 */
export function mentionNameSet(mentions: string[] | undefined, rosterFallback: string[] | undefined, loginName?: string | null): string[] {
  const base = mentions !== undefined ? mentions : (rosterFallback ?? []);
  return loginName ? [...base, loginName] : base;
}
