// User display identity.
//
// The user is represented internally as sender="user" in message-store and
// routing, but rendered with a human display name in agent-visible envelopes
// (room headers, private-message envelopes). Reads the install login name at
// runtime so a second user is not shown as someone else's hardcoded name.

import { readConfig } from "./config.js";

const FALLBACK_DISPLAY_NAME = "User";

/** Human-visible name for sender="user". Auth username, else "User". */
export function getUserDisplayName(): string {
  try {
    const name = String(readConfig().auth?.username ?? "").trim();
    return name || FALLBACK_DISPLAY_NAME;
  } catch {
    return FALLBACK_DISPLAY_NAME;
  }
}
