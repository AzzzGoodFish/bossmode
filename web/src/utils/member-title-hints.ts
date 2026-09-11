/** Mention descriptions use the current card title, never a historical template. */
export function memberTitleHints(members: readonly { name: string; title?: string | null }[]): Record<string, string> {
  return Object.fromEntries(members.map(member => [member.name, member.title ?? ""]));
}
