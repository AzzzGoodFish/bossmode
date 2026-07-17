import type { AvailableModelOption } from "../api/client";

export const ALL_THINKING_LEVELS: Array<{ label: string; value: string | null }> = [
  { label: "default", value: null },
  { label: "off", value: "off" },
  { label: "minimal", value: "minimal" },
  { label: "low", value: "low" },
  { label: "medium", value: "medium" },
  { label: "high", value: "high" },
  { label: "xhigh", value: "xhigh" },
  { label: "max", value: "max" },
];

/**
 * Thinking levels actually selectable for a given model option.
 *
 * Mirrors pi's `getSupportedThinkingLevels` (pi-ai models.ts) exactly — the
 * rule is asymmetric, and getting it wrong in either direction breaks real
 * models (0.18.4 shipped a regression that cut Claude models to off/max only):
 *
 *   if (!model.reasoning) return ["off"];
 *   levels.filter(level => {
 *     const mapped = model.thinkingLevelMap?.[level];
 *     if (mapped === null) return false;                       // explicit null disables
 *     if (level === "xhigh" || level === "max") return mapped !== undefined;  // xhigh/max need explicit presence
 *     return true;                                             // off/minimal/low/medium/high: available unless explicitly null
 *   });
 *
 * So: mid levels and off are available by default and only removed by an
 * explicit null entry; xhigh/max must be explicitly present. `default` is
 * always available (it maps to "no thinking override"), independent of the map.
 */
export function availableThinkingLevels(model: Pick<AvailableModelOption, "reasoning" | "thinkingLevelMap"> | null | undefined) {
  if (!model) return ALL_THINKING_LEVELS;
  if (model.reasoning === false) return ALL_THINKING_LEVELS.filter((l) => l.value === null || l.value === "off");
  const map = model.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((l) => {
    if (l.value === null) return true; // "default" always available
    if (l.value === "off") return map?.off !== null;
    if (l.value === "xhigh" || l.value === "max") return map?.[l.value] != null;
    // off/minimal/low/medium/high: available unless explicitly null
    const key = l.value as "minimal" | "low" | "medium" | "high";
    return map?.[key] !== null;
  });
}

/**
 * Find the catalog option matching a member's bound model + credential, if any.
 * Mirrors the member-card availability check: model id + credential id must
 * both match, so a bare model name cannot accidentally match the wrong profile.
 */
export function findModelOptionForBinding(
  modelRef: string | null | undefined,
  credentialId: string | null | undefined,
  models: AvailableModelOption[],
): AvailableModelOption | undefined {
  if (!modelRef || !credentialId) return undefined;
  const slash = modelRef.indexOf("/");
  const modelId = slash >= 0 ? modelRef.slice(slash + 1) : modelRef;
  return models.find((m) => m.profileId === credentialId && m.modelId === modelId);
}
