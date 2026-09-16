// Member-facing contract version gate (fish 2026-08-07).
//
// Only changes to the member-facing conversation contract require a bump:
// - the reply/delivery channel (e.g. chat tool ↔ response tool ↔ response: prefix)
// - tool surface semantics (added/removed tools, parameter meaning changes)
// - activation envelope format (banner text, reply-debt contract)
//
// Bump rules:
// - Bump (+1) ONLY when a code change alters how members converse — the
//   "what must I do to reply" contract.  Prompt text tweaks, description
//   wording, CSS, and feature additions that don't change the reply path
//   do NOT bump.
// - Every bump is a release-process obligation: the commit that changes
//   the contract MUST include the version bump in the same commit.
// - The number is monotonic; never decrease.

export const MEMBER_CONTRACT_VERSION = 2;
