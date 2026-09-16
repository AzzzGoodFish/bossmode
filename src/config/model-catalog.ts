/** DB-backed catalog; packaged SDK models remain immutable bundled defaults. */
import { getDatabase } from "../data/database.js";
import { CatalogRepository, DatabaseModelsStore } from "./pi-adapt/models-store.js";
import { logger } from "../kernel/logger.js";
function repository(): CatalogRepository { return new CatalogRepository(getDatabase()); }
export function createDatabaseModelsStore(): DatabaseModelsStore { return new DatabaseModelsStore(repository()); }

export type CatalogRefreshSource = "remote" | "bundled";

export interface CatalogSnapshot {
  /** Effective model rows (remote overlay if present, else bundled). */
  models: any[];
  /** Which layer is currently serving reads. */
  source: CatalogRefreshSource;
  /** Epoch ms of last successful remote refresh; null if never had remote. */
  fetchedAt: number | null;
  /** ISO string of fetchedAt, or null. */
  fetchedAtIso: string | null;
  modelCount: number;
}

export interface DiskCatalogCache {
  models: any[];
  /** Epoch ms when this cache was written (successful remote). */
  fetchedAt: number;
  updatedAt: string;
}

/** Shape matches pi-ai ModelsStoreEntry (models-store.json per-provider value). */
export interface ProviderModelsStoreEntry {
  models: any[];
  lastModified?: number;
  checkedAt?: number;
  etag?: string;
}

let bundledLoader: () => any[] = () => [];
let testModels: any[] | null = null;
let networkRefreshForTests: null | (() => Promise<{ source: CatalogRefreshSource; error?: string }>) = null;

/** Explicit test overrides only. Production reads always query the database. */
let remoteModels: any[] | null = null;
let remoteFetchedAt: number | null = null;
/** Explicit test-only provider override. */
let providerOverlays: Record<string, ProviderModelsStoreEntry> | null = null;

/** Inject the packaged-catalog reader (owned by model-credentials registry warm path). */
export function setBundledCatalogLoader(fn: () => any[]): void {
  bundledLoader = fn;
}

export function setPiCatalogModelsForTests(models: any[] | null): void {
  testModels = models;
}

export function setCatalogNetworkRefreshForTests(
  fn: null | (() => Promise<{ source: CatalogRefreshSource; error?: string }>),
): void {
  networkRefreshForTests = fn;
}

export function getCatalogNetworkRefreshForTests(): null | (() => Promise<{ source: CatalogRefreshSource; error?: string }>) {
  return networkRefreshForTests;
}

export function getPiCatalogModelsForTests(): any[] | null {
  return testModels;
}

/** Retained bootstrap entry point; reads the bound DB, never legacy disk. */
export function hydrateCatalogFromDisk(): void { repository().remote(); }

/**
 * Read-through catalog. Always returns an answer.
 * Priority: test override → remote overlay → bundled loader.
 */
export function getCatalog(): CatalogSnapshot {
  const stored = repository().remote();
  const models = remoteModels ?? stored?.models;
  const fetchedAt = remoteModels ? remoteFetchedAt : stored?.fetchedAt ?? null;
  if (testModels) {
    return {
      models: testModels,
      source: "remote",
      fetchedAt,
      fetchedAtIso: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      modelCount: testModels.length,
    };
  }
  if (models && models.length > 0) {
    return {
      models,
      source: "remote",
      fetchedAt,
      fetchedAtIso: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      modelCount: models.length,
    };
  }
  const bundled = bundledLoader();
  return {
    models: bundled,
    source: "bundled",
    fetchedAt: null,
    fetchedAtIso: null,
    modelCount: bundled.length,
  };
}

/** Convenience: just the model rows. */
export function getCatalogModels(): any[] {
  return getCatalog().models;
}

export function catalogForProvider(providerSlug: string): any[] {
  return getCatalogModels().filter((m) => m?.provider === providerSlug);
}

/**
 * Commit a successful remote overlay to the database. Only call on verified success.
 * Never used for failure paths.
 */
export function commitRemoteCatalog(models: any[], fetchedAt: number = Date.now()): void {
  if (!Array.isArray(models) || models.length === 0) {
    logger.warn("catalog", "commitRemoteCatalog ignored empty models");
    return;
  }
  if (!repository().importRemote({ models, fetchedAt, updatedAt: new Date(fetchedAt).toISOString() })) return;
  logger.info("catalog", "remote catalog committed", {
    modelCount: models.length,
    fetchedAt: new Date(fetchedAt).toISOString(),
  });
}

/**
 * Explicitly keep last-good on a failed/empty refresh. Logs; never clears remote.
 */
export function retainLastGoodCatalog(reason: string, error?: string): CatalogSnapshot {
  const snap = getCatalog();
  logger.warn("catalog", "refresh kept last-good catalog", {
    reason,
    error,
    source: snap.source,
    modelCount: snap.modelCount,
    fetchedAt: snap.fetchedAtIso,
  });
  return snap;
}

/** Clears test overrides, not database state. */
export function clearRemoteCatalogMemoryForTests(): void {
  remoteModels = null;
  remoteFetchedAt = null;
  providerOverlays = null;
}

export function commitProviderOverlays(overlays: Record<string, ProviderModelsStoreEntry>): void {
  repository().importOverlays(overlays);
}

export function hydrateProviderOverlaysFromDisk(): void { repository().overlays(); }

/**
 * Effective per-provider overlays for the native SDK ModelsStore.
 * Prefers last committed overlay; if missing, synthesizes from CatalogStore models
 * using fetchedAt as lastModified (must beat pi builtin generatedAt).
 */
export function getProviderOverlays(): Record<string, ProviderModelsStoreEntry> {
  if (providerOverlays && Object.keys(providerOverlays).length > 0) {
    return providerOverlays;
  }
  const disk = repository().overlays();
  if (disk && Object.keys(disk).length > 0) {
    return disk;
  }
  // Synthesize from flat catalog so export still seeds something after hydrate-only.
  const snap = getCatalog();
  if (snap.source !== "remote" || !snap.models.length) return {};
  const lastModified = snap.fetchedAt && snap.fetchedAt > 0 ? snap.fetchedAt : Date.now();
  const checkedAt = lastModified;
  const byProvider = new Map<string, any[]>();
  for (const m of snap.models) {
    const p = m?.provider ? String(m.provider) : "";
    if (!p) continue;
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(m);
  }
  const out: Record<string, ProviderModelsStoreEntry> = {};
  for (const [providerId, models] of byProvider) {
    out[providerId] = { models, lastModified, checkedAt };
  }
  return out;
}

export function clearProviderOverlaysMemoryForTests(): void {
  providerOverlays = null;
}

export function setProviderOverlaysMemoryForTests(overlays: Record<string, ProviderModelsStoreEntry> | null): void {
  providerOverlays = overlays;
}

/** Test helper — seed an explicit override without a database write. */
export function setRemoteCatalogMemoryForTests(models: any[] | null, fetchedAt: number | null = Date.now()): void {
  remoteModels = models;
  remoteFetchedAt = models && models.length ? fetchedAt : null;
}

export function formatCatalogFreshness(snap: CatalogSnapshot = getCatalog()): string {
  if (snap.source === "remote" && snap.fetchedAtIso) {
    return `Catalog updated ${formatRelativeFetchedAt(snap.fetchedAt)}`;
  }
  if (snap.source === "bundled") {
    return "Using packaged catalog";
  }
  return "Catalog status unknown";
}

function formatRelativeFetchedAt(fetchedAt: number | null): string {
  if (!fetchedAt) return "at unknown time";
  const deltaSec = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
  if (deltaSec < 60) return "just now";
  const mins = Math.round(deltaSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
