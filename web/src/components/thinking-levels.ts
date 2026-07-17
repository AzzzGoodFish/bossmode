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
 * - `default` and `off` are always available.
 * - For catalog models with a `thinkingLevelMap`, only the levels present in
 *   the map are offered (e.g. Kimi K3 exposes only `max`, matching pi CLI).
 * - For models with `reasoning: false`, only default/off are offered.
 * - For custom models without thinking metadata (no `thinkingLevelMap` and
 *   `reasoning` not explicitly false), all levels remain available — the
 *   metadata is unknown, so we do not restrict.
 */
export function availableThinkingLevels(model: Pick<AvailableModelOption, "reasoning" | "thinkingLevelMap"> | null | undefined) {
  if (!model) return ALL_THINKING_LEVELS;
  if (model.reasoning === false) return ALL_THINKING_LEVELS.filter((l) => l.value === null || l.value === "off");
  const map = model.thinkingLevelMap;
  if (!map) return ALL_THINKING_LEVELS;
  // pi's catalog writes every level key for some models and sets the
  // unsupported ones to null (e.g. Kimi K3: only `max` is non-null). A key
  // with a null value means the level is NOT available — only count non-null.
  const allowed = new Set(Object.entries(map).filter(([, v]) => v != null).map(([k]) => k));
  return ALL_THINKING_LEVELS.filter((l) => l.value === null || l.value === "off" || allowed.has(l.value));
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
