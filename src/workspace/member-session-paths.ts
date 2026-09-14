import { join } from "node:path";
import { memberDir } from "./member-profile.js";

/**
 * Member-level session directory (① A2): a member has one session across all
 * chats — `members/<id>/sessions/<day>/main/`. The pi session file itself is
 * unchanged; only its owning directory loses the per-scope split.
 */
export function mainSessionDirectory(memberId: string, startedAt = new Date()): string {
  const day = startedAt.toISOString().slice(0, 10);
  return join(memberDir(memberId), "sessions", day, "main");
}
