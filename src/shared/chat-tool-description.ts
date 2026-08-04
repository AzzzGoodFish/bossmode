// Canonical description for the `chat` tool used by agent tool definitions.
// Centralizing this keeps the @mention contract in a single source of truth.
// Description scope: capability + mechanical facts only (no usage guidance —
// that belongs to Room/Member Principles and Core).

export function buildChatToolDescription(memberList: string): string {
  return `Post a message to the room.

- message (required): text content. @name activates that member and asks for a reply; @name must exactly match a member name; a plain name never activates.
- attachments (optional): local file paths, copied to the room's attachment store.
- artifacts (optional): file paths shown as previewable chips on the message.

Room members: ${memberList}`;
}

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post. @name activates that member and requests a reply; a plain name does not.";
