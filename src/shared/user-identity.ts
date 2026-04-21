// User display identity.
//
// The user is represented internally as sender="user" in message-store and
// routing, but rendered with a human display name in agent-visible envelopes
// (room headers, private-message envelopes). Centralizing this string lets us
// change the display name in one place and, later, swap in per-user identity
// without touching the envelope and wrapping logic.

export const USER_DISPLAY_NAME = "fish";
