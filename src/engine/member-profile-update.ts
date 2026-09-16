import { logger } from "../kernel/logger.js";
import { getMember, updateMemberIdentity, MemberNotFoundError } from "../workspace/member-registry.js";
import { notifyMemberProfileChanged } from "./agent-manager.js";
import { broadcastMemberProfileChanged } from "../communication/ws.js";

export class InvalidProfileError extends Error {
  readonly code = "invalid_profile";
}

/** Validate before committing either field. The API adapter may convert title=null to "". */
export function validateProfilePatch(input: unknown): { name?: string; title?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidProfileError("Expected name and/or title.");
  const patch = input as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length) throw new InvalidProfileError("Provide at least one of name or title.");
  for (const key of keys) {
    if (key !== "name" && key !== "title") throw new InvalidProfileError(`Unknown profile field: ${key}. Only name and title are editable.`);
    if (typeof patch[key] !== "string") throw new InvalidProfileError(`${key} must be a string.`);
  }
  return patch as { name?: string; title?: string };
}

/** One committed identity update, shared by the self-only tool and global API. */
export function updateProfileForMember(memberId: string, input: unknown) {
  const patch = validateProfilePatch(input);
  const before = getMember(memberId);
  if (!before) throw new MemberNotFoundError(memberId);
  let member;
  try { member = updateMemberIdentity(memberId, patch); }
  catch (error) {
    if ((error as Error).message === "reserved_member_name") throw new InvalidProfileError("all, user and system are reserved for group mentions, the human user and system messages.");
    if ((error as Error).message === "invalid_member_name") {
      throw new InvalidProfileError("Name must be non-empty, at most 64 characters, and contain no slash or NUL.");
    }
    throw error;
  }
  const changed = member.name !== before.name || member.title !== before.title;
  const warnings: string[] = [];
  if (changed) {
    // No IO or asynchronous gap between commit and live metadata publication.
    for (const publish of [
      () => notifyMemberProfileChanged(member),
      () => broadcastMemberProfileChanged({ memberId, name: member.name, title: member.title ?? null }),
    ]) {
      try { publish(); }
      catch (error) {
        logger.error("member-profile", "committed profile notification failed", { memberId, error: String(error) });
        warnings.push("Profile was saved, but a live view could not be notified. Refresh that view.");
      }
    }
  }
  return { memberId, name: member.name, title: member.title ?? null, changed, ...(warnings.length ? { warnings } : {}) };
}
