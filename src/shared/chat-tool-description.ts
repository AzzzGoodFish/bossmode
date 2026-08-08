// Canonical description for the `chat` tool used by agent tool definitions.
// Centralizing this keeps the @mention contract in a single source of truth.
// Description scope: capability + mechanical facts only (no usage guidance —
// that belongs to Room/Member Principles and Core).

export function buildChatToolDescription(memberList: string): string {
  return `Post a message to the room.

- message (required): text content. @name activates that member (exact match required; a plain name never activates). Set need_response=true when you need their reply.
- attachments (optional): local file paths, copied to the room's attachment store.
- artifacts (optional): file paths shown as previewable chips on the message.
- need_response (optional, default false): Set true when you need the @-mentioned member's reply to move your work forward — their reply is then guaranteed to reach the room, even if they don't call chat. Default false = FYI, no reply expected.

Room members: ${memberList}`;
}

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post. @name activates that member (exact match required; a plain name never activates). Set need_response=true when you need their reply.";
