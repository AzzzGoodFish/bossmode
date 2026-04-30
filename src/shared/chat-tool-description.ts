// Canonical description for the `chat` tool, shared across runtimes (pi-cli + MCP).
// Centralizing this avoids drift between the two runtime adapters and keeps the
// envelope/target/mentions contract in a single source of truth.

export function buildChatToolDescription(memberList: string): string {
  return `Post a message.

Parameters:
- message (required): text content
- target (optional): "room" | "user"
  - Default: "room" for room conversations, "user" for private messages.
  - "room": visible to everyone in the room (the normal case)
  - "user": private reply, only the user sees it.
  - The envelope footer suggests a default target. You may override it when the user explicitly asks (e.g. "post this to the room" or "reply privately").
- mentions (optional): array of agent names to activate, e.g. ["developer","qa"]. This is the only activation channel. @name in message text is a reference only.

Rules:
- Follow the envelope footer's suggested target unless the user explicitly requests otherwise.
- In room replies, include mentions[] only for agents you need to activate next.

Available mention targets in this room: ${memberList}`;
}

export const CHAT_TARGET_PARAM_DESCRIPTION =
  '"room" or "user"; default follows triggering envelope footer';

export const CHAT_MENTIONS_PARAM_DESCRIPTION =
  "Agent names to activate (authoritative activation channel)";

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post";
