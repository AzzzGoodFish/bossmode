/**
 * Batch 3 (member-centric tools): the canonical member tool surface.
 *
 * Single source of truth for the *names* of the tools a member can call:
 * - MEMBER_DIRECT_TOOL_NAMES — tools registered directly on the runtime
 *   (createBossmodeSdkTools); a test locks the registration against this list,
 *   so the two cannot drift.
 * - MEMBER_GATEWAY_TOOL_NAMES — capabilities reached through the `bossmode`
 *   gateway (list / describe / call).
 *
 * The unknown-tool guidance derives its "available" list from here — never from
 * a hand-maintained retired-name mapping.
 */

export const MEMBER_DIRECT_TOOL_NAMES = [
  "chat_send",
  "chat_read",
  "chat_search",
  "chat_list",
  "bossmode",
  "workspace_list",
  "workspace_create",
  "workspace_use",
  "workspace_remove",
  "read",
  "write",
  "edit",
  "shell_create",
  "shell_exec",
  "shell_read",
  "shell_wait",
  "shell_list",
  "shell_close",
  "reload",
] as const;

export const MEMBER_GATEWAY_TOOL_NAMES = [
  "chat_info",
  "chat_create",
  "chat_edit",
  "member_list",
  "member_info",
  "profile_read",
  "profile_update",
] as const;

/** qm-style guidance for a tool name the member surface does not know. */
export function unknownMemberToolMessage(tool: string): string {
  return `Unknown tool "${tool}" — available: ${MEMBER_DIRECT_TOOL_NAMES.join(", ")}. `
    + `Gateway capabilities (${MEMBER_GATEWAY_TOOL_NAMES.join(", ")}) are called through bossmode: `
    + `{action:"list"} to discover them, {action:"describe", tool:"<name>"} for parameters, `
    + `{action:"call", tool:"<name>", args:{…}} to run one.`;
}
