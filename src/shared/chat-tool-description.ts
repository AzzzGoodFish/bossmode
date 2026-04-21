// Canonical description for the `chat` tool, shared across runtimes (pi-cli + MCP).
// Centralizing this avoids drift between the two runtime adapters and keeps the
// envelope/target/mentions contract in a single source of truth.

export function buildChatToolDescription(memberList: string): string {
  return `Post a message.

Parameters:
- message (required): text content
- target (optional): "room" | "user"
  - Default: follow the "Reply via chat: target=..." instruction in the envelope of the triggering message (the last one in your delivery, the one that carries a [Reply via chat: ...] footer). That instruction is authoritative.
  - "room": visible to everyone in the room (the normal case)
  - "user": private reply, only the user sees it. Use ONLY when the triggering envelope says so (i.e. the incoming message was a [Private message from user ...]).
- mentions (optional): array of agent names to activate, e.g. ["developer","qa"]. This is the only activation channel. @name in message text is a reference only.

Rules:
- Follow the footer of the triggering message for target. Do not override unless you are proactively starting a new conversation with no room activation in the current turn.
- If activated by a room mention and you try target="user", the server rewrites it to "room" and returns a warning.
- In room replies, include mentions[] only for agents you need to activate next.

Available mention targets in this room: ${memberList}`;
}

export const CHAT_TARGET_PARAM_DESCRIPTION =
  '"room" or "user"; default follows the triggering envelope footer';

export const CHAT_MENTIONS_PARAM_DESCRIPTION =
  "Agent names to activate (authoritative activation channel)";

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post";
