// Canonical description for the `chat` tool used by agent tool definitions.
// Centralizing this keeps the @mention contract in a single source of truth.
// Description scope: capability + mechanical facts only (no usage guidance —
// that belongs to Room/Member Principles and Core).

export function buildChatToolDescription(): string {
  return `Post a message to the room.

- message (required): text content. @name activates that member (exact match required; a plain name never activates).
- attachments (optional): local file paths, copied to the room's attachment store.`;
}

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post. @name activates that member (exact match required; a plain name never activates).";
