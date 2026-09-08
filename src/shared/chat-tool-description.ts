// Canonical description for the `chat` tool used by agent tool definitions.
// Centralizing this keeps the @mention contract in a single source of truth.
// Description scope: capability + mechanical facts only (no usage guidance —
// that belongs to Room/Member Principles and Core).

export function buildChatToolDescription(): string {
  return `Post a message to the room.

- message (required): text content. @name activates that member (exact match required; a plain name never activates).
- attachments (optional): local file paths, copied to the room's attachment store.
- need_response (optional): member name list who must reply. Omit = FYI (no reply expected). When set, only listed @-mentioned members owe a reply (guaranteed to reach the room even without chat). Other @-mentions stay FYI.
- reply_to (optional): reference a message in this scope as \`msg:#<seq>\`. The posted message carries a quote block with the original excerpt; the target must exist in the current room or DM.`;
}

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post. @name activates that member (exact match required; a plain name never activates). Optional need_response lists who must reply.";
