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
- IMPORTANT: @name activates that member and asks them to reply. Only use @name when you need a response from that member.
- For status updates, acknowledgements, thanks, FYI, or referring to someone without needing a reply, write their name without @.
- @name must exactly match a member name.
- Private messages do not activate members.

Artifacts:
- Optionally include artifacts: [path] on room messages to show previewable document/file chips.
- Use artifacts for deliverables and referenced docs; the user can preview them in-place and reply naturally.

Rules:
- Follow the envelope footer's suggested target unless the user explicitly requests otherwise.

Available @ targets in this room: ${memberList}`;
}

export const CHAT_TARGET_PARAM_DESCRIPTION =
  '"room" or "user"; default follows triggering envelope footer';

export const CHAT_MESSAGE_PARAM_DESCRIPTION = "Message to post. In room messages, @name activates that member and requests a reply; for acknowledgements/FYI/thanks, write names without @.";
