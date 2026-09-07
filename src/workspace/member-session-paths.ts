import { join } from "node:path";
import { memberDir } from "./member-profile.js";

export function mainSessionDirectory(memberId: string, scope: string, startedAt = new Date()): string {
  const day = startedAt.toISOString().slice(0, 10);
  if (scope.startsWith("room:")) return join(memberDir(memberId), "sessions", day, "rooms", scope.slice(5));
  if (scope.startsWith("topic:")) return join(memberDir(memberId), "sessions", day, "topics", scope.slice(6));
  return join(memberDir(memberId), "sessions", day, "dm");
}
