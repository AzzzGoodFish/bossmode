import { join } from "node:path";
import { memberDir } from "./member-profile.js";

export function mainSessionDirectory(memberId: string, scope: string, startedAt = new Date()): string {
  const day = startedAt.toISOString().slice(0, 10);
  if (/^room:[^/]+$/.test(scope)) return join(memberDir(memberId), "sessions", day, "rooms", scope.slice(5));
  if (scope === `dm:${memberId}`) return join(memberDir(memberId), "sessions", day, "dm");
  throw new Error(`Invalid member session scope: ${scope}`);
}
