// Canonical description for the `chat` tool used by agent tool definitions.
// Centralizing this keeps the envelope/target/@mention contract in a single source of truth.

export function buildChatToolDescription(memberList: string): string {
  return `Post a message.

Parameters:
- message (required): text content
- target (optional): "room" | "user"
  - Default: "room" for room conversations, "user" for private messages.
  - "room": visible to everyone in the room (the normal case)
  - "user": private reply, only the user sees it.
  - The envelope footer suggests a default target. You may override it when the user explicitly asks (e.g. "post this to the room" or "reply privately").

Activation:
- In room messages, write @name in the message text to activate a member and request their reply.
- @name must exactly match a member name.
- Use @name only when you want that member to reply. To refer to someone without activating them, write their name without @.
- Private messages do not activate members.

Rules:
- Follow the envelope footer's suggested target unless the user explicitly requests otherwise.

Available @ targets in this room: ${memberList}`;
}

export const CHAT_TARGET_PARAM_DESCRIPTION =
  '"room" or "user"; default follows triggering envelope footer';

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post";
