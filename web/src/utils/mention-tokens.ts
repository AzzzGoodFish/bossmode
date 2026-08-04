/**
 * Mention token splitting + three-tier pills (Design: mention-highlight v2,
 * fish-approved 2026-08-04).
 *
 * Tiers (existing tokens only, zero new):
 * - `@member` queued activation → accent pill
 * - `@<loginName>` (@me, same judgement as unread mentioned) → amber pill
 * - `!member` urgent interrupt → blocked-red pill
 *
 * Rules mirror the backend parser: only real member names are tinted (an @/!
 * followed by a non-member is plain text); `!` needs a left boundary so
 * "Hello!pm" never fires; code spans/links are excluded by the callers (the
 * remark plugin never visits them; the plain-text path has no code concept).
 */

export type MentionTier = "member" | "self" | "urgent";

export interface MentionTokenPart {
  text: string;
  tier?: MentionTier;
}

export const MENTION_PILL_CLASSES: Record<MentionTier, string> = {
  member: "bg-accent-dim text-accent-ink rounded px-[3px] py-px font-medium",
  self: "bg-think-dim text-think rounded px-[3px] py-px font-semibold",
  urgent: "bg-blocked-dim text-blocked rounded px-[3px] py-px font-semibold",
};

const LEGAL_NAME_CHAR = "[\\w.-]";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface MentionTokenOptions {
  /** Names eligible for highlighting — persisted mention snapshot, or the room roster fallback, plus the user's login name. */
  names: string[];
  /** `!` urgent targets (persisted snapshot). A `!name` only tints red when the name is in this set — otherwise plain text. */
  urgentNames?: string[];
  /** Human user's login name → "self" (amber) tier for `@<loginName>`. */
  loginName?: string | null;
}

/**
 * Split text into plain and mention parts. A token is `@name` or `!name`;
 * membership decides whether it tints at all, the prefix + snapshots decide the tier.
 */
export function splitMentionTokens(content: string, opts: MentionTokenOptions): MentionTokenPart[] {
  if (!content) return [];
  const names = [...new Set(opts.names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (names.length === 0) return [{ text: content }];
  const urgent = new Set(opts.urgentNames ?? []);
  const loginName = opts.loginName || undefined;

  // The left-boundary rule applies to `!` only ("Hello!pm" must not fire);
  // `@` keeps the long-standing behavior (no left constraint — the backend
  // parser works the same way). Boundary is captured, not lookbehind, to keep
  // parity with older JS targets.
  const nameAlt = names.map(escapeRegex).join("|");
  const bangRe = `(^|[^\\w!])(!)(${nameAlt})(?!${LEGAL_NAME_CHAR})`;
  const atRe = `(@)(${nameAlt})(?!${LEGAL_NAME_CHAR})`;
  const matcher = new RegExp(`${bangRe}|${atRe}`, "g");

  const parts: MentionTokenPart[] = [];
  let cursor = 0;
  for (let match = matcher.exec(content); match; match = matcher.exec(content)) {
    const isBang = match[2] === "!";
    const boundary = isBang ? match[1] : "";
    const prefix = isBang ? "!" : "@";
    const name = (isBang ? match[3] : match[5]) as string;
    const tokenStart = match.index + boundary.length;
    if (tokenStart > cursor) parts.push({ text: content.slice(cursor, tokenStart) });
    let tier: MentionTier | undefined;
    if (prefix === "!") {
      // A `!` before a non-urgent name is plain text (parser never fired either).
      if (urgent.has(name)) tier = "urgent";
    } else {
      tier = loginName && name === loginName ? "self" : "member";
    }
    if (tier) {
      parts.push({ text: `${prefix}${name}`, tier });
    } else {
      parts.push({ text: match[0].slice(boundary.length) });
    }
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
