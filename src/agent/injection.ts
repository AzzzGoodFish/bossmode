/**
 * Platform-injection detection (spec unified-user-prompt v1.6).
 *
 * A user-role input is a platform injection when its entire text is one
 * well-formed <platform_directive> element (surrounding whitespace allowed).
 * Real chat traffic — <chat_message> elements — never counts,
 * mirroring Grok Bot's isNotificationOnlyUserMessage discipline: the platform
 * can reliably tell synthetic inputs from human/member messages without
 * trusting prose conventions.
 */

const DIRECTIVE_OPEN = /^<platform_directive(\s|>)/;
const DIRECTIVE_CLOSE = "</platform_directive>";
const DIRECTIVE_SELF_CLOSE = /\/>$/;

export function isPlatformInjection(text: string): boolean {
  const value = String(text ?? "").trim();
  if (!value.startsWith("<platform_directive") || !DIRECTIVE_OPEN.test(value)) return false;
  if (DIRECTIVE_SELF_CLOSE.test(value)) return (value.match(/</g) ?? []).length === 1;
  if (!value.endsWith(DIRECTIVE_CLOSE)) return false;
  // Exactly one top-level element: no other content outside the wrapper and
  // no nested directives.
  const inner = value.slice(value.indexOf(">") + 1, value.length - DIRECTIVE_CLOSE.length);
  return !inner.includes("<platform_directive");
}
