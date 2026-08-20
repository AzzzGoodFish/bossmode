/**
 * Kimi-coding (anthropic-messages) rejects thinking signatures that are not
 * base64url. Session history often stores standard base64 (with +/). Clearing
 * invalid signatures lets allowEmptySignature keep the thinking text without a
 * 400 on the next turn.
 */

/** RFC 4648 §5 base64url: A-Z a-z 0-9 - _ with optional = padding. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

export function isBase64Url(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  if (value.length % 4 === 1) return false; // invalid pad length
  return BASE64URL_RE.test(value);
}

/** True when a non-empty signature would fail Kimi's base64url check. */
export function isInvalidThinkingSignature(signature: unknown): boolean {
  if (signature === undefined || signature === null) return false;
  const s = String(signature);
  if (s.trim().length === 0) return false;
  return !isBase64Url(s);
}

type ContentBlock = {
  type?: string;
  thinkingSignature?: string;
  [key: string]: unknown;
};

type SessionMessage = {
  role?: string;
  content?: ContentBlock[] | string;
  [key: string]: unknown;
};

/**
 * In-place: clear thinkingSignature on assistant blocks that are not base64url.
 * Returns how many signatures were cleared.
 */
export function sanitizeThinkingSignaturesInMessages(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let cleared = 0;
  for (const raw of messages as SessionMessage[]) {
    if (!raw || raw.role !== "assistant") continue;
    const content = raw.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "thinking") continue;
      if (!isInvalidThinkingSignature(block.thinkingSignature)) continue;
      block.thinkingSignature = "";
      cleared += 1;
    }
  }
  return cleared;
}

/** kimi-coding needs empty-signature thinking blocks kept as thinking, not text. */
export function ensureKimiAllowEmptySignature(model: { provider?: string; compat?: Record<string, unknown> } | null | undefined): void {
  if (!model || model.provider !== "kimi-coding") return;
  const compat = (model.compat && typeof model.compat === "object") ? model.compat : {};
  if (compat.allowEmptySignature === true) return;
  model.compat = { ...compat, allowEmptySignature: true };
}
