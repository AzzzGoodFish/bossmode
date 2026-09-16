// Canonical copy for the `chat_send` tool used by agent tool definitions.
// Centralizing this keeps the @mention contract in a single source of truth.
// Description scope: capability + mechanical facts only (no usage guidance —
// that belongs to Room/Member Principles and Core).

export function buildChatSendToolDescription(): string {
  return `Send a message to one chat.
- to (required): target chat — id or name; your private chat with the user is "dm:<your member id>" (or "user"). Private chats need no prior creation.
- message (required): text content.
- attachments (optional): local file paths, copied into that chat's attachment store.`;
}

export const CHAT_SEND_TO_PARAM_DESCRIPTION = "Target chat id or name; your private chat with the user is \"dm:<your member id>\" (or \"user\").";

export const CHAT_SEND_MESSAGE_PARAM_DESCRIPTION = "Message to post. @name activates that member (exact match required; a plain name never activates).";

export const CHAT_SEND_ATTACHMENTS_PARAM_DESCRIPTION = "Local file paths to attach. Files are copied to the target chat's attachment store.";
