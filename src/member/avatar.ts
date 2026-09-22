/** Character appearance only. Empty values mean deterministic member-ID defaults. */
export const MEMBER_AVATAR_SHAPES = ['blob','pebble','squircle','tablet','wedge','hex','cloud','teardrop'] as const;
export const MEMBER_AVATAR_COLORS = ['black','brown','red','orange','yellow','green','cyan','blue','violet','magenta','gray'] as const;
export type MemberAvatarShape = typeof MEMBER_AVATAR_SHAPES[number];
export type MemberAvatarColor = typeof MEMBER_AVATAR_COLORS[number];
export function validateAvatarChoice(value: unknown, field: 'shape'|'color'): string | null {
  if (value === null || value === '') return null;
  const allowed: readonly string[] = field === 'shape' ? MEMBER_AVATAR_SHAPES : MEMBER_AVATAR_COLORS;
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('invalid_member_avatar');
  return value;
}
export function validateAvatarPatch(patch: {avatarShape?: unknown;avatarColor?: unknown}): void {
  if (patch.avatarShape !== undefined) validateAvatarChoice(patch.avatarShape,'shape');
  if (patch.avatarColor !== undefined) validateAvatarChoice(patch.avatarColor,'color');
}
