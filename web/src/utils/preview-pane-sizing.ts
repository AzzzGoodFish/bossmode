export const PREVIEW_PCT_STORAGE_KEY = "bossmode.previewPanePct";
export const PREVIEW_LEGACY_WIDTH_STORAGE_KEY = "bossmode.artifactPreviewWidth";

// Preview pane occupies 25–75% of the chat+preview area (GOO-130; both sides stay usable).
export const PREVIEW_MIN_PCT = 25;
export const PREVIEW_MAX_PCT = 75;
export const PREVIEW_DEFAULT_PCT = 32;

export function clampPreviewPct(value: number): number {
  if (!Number.isFinite(value)) return PREVIEW_DEFAULT_PCT;
  return Math.min(PREVIEW_MAX_PCT, Math.max(PREVIEW_MIN_PCT, value));
}

export function readPreviewPct(storage: Pick<Storage, "getItem">, viewportWidth: number): number {
  const rawPct = storage.getItem(PREVIEW_PCT_STORAGE_KEY);
  const pct = rawPct ? parseFloat(rawPct) : NaN;
  if (Number.isFinite(pct)) return clampPreviewPct(pct);

  // One-time migration from the legacy pixel key. The caller persists the returned
  // percentage through the normal state effect so the preference becomes responsive.
  const rawPx = storage.getItem(PREVIEW_LEGACY_WIDTH_STORAGE_KEY);
  const px = rawPx ? parseInt(rawPx, 10) : NaN;
  if (Number.isFinite(px) && viewportWidth > 0) return clampPreviewPct((px / viewportWidth) * 100);

  return PREVIEW_DEFAULT_PCT;
}

export function formatPreviewPct(value: number): string {
  return String(Math.round(clampPreviewPct(value) * 10) / 10);
}
