/** Suggest a room-local member name from an Agent template and occupied names. */
export function suggestMemberName(agentName: string, occupiedNames: Iterable<string>): string {
  const base = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "member";
  const occupied = new Set([...occupiedNames].map((name) => name.trim().toLowerCase()));
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
