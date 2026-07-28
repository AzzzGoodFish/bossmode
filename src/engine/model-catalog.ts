/**
 * CatalogStore — process-singleton source of truth for the model directory.
 *
 * Two layers:
 *   bundled  — packaged SDK catalog (constant fallback)
 *   remote   — last successful pi.dev refresh (disk cache + in-memory image)
 *
 * Rules (v2a):
 *   - getCatalog() always returns an answer (read-through)
 *   - refresh success atomically replaces remote (temp+rename on disk, then memory)
 *   - refresh failure keeps last-good remote forever — never null out on error
 *   - fetchedAt tracks the last successful remote refresh (null if never remote)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { getBossmodeDir, ensureBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";

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

const CACHE_FILE = "pi-catalog-remote.json";

let bundledLoader: () => any[] = () => [];
let testModels: any[] | null = null;
let networkRefreshForTests: null | (() => Promise<{ source: CatalogRefreshSource; error?: string }>) = null;

/** In-memory remote overlay — only replaced on successful refresh / disk hydrate. */
let remoteModels: any[] | null = null;
let remoteFetchedAt: number | null = null;

function cachePath(): string {
  return join(getBossmodeDir(), CACHE_FILE);
}

function writePrivateJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best-effort */ }
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

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

function readDiskCache(): DiskCatalogCache | null {
  try {
    const path = cachePath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(data?.models) || data.models.length === 0) return null;
    const fetchedAt = typeof data.fetchedAt === "number" && Number.isFinite(data.fetchedAt)
      ? data.fetchedAt
      : (typeof data.updatedAt === "string" ? Date.parse(data.updatedAt) : NaN);
    const ts = Number.isFinite(fetchedAt) ? fetchedAt : Date.now();
    return { models: data.models, fetchedAt: ts, updatedAt: data.updatedAt || new Date(ts).toISOString() };
  } catch {
    return null;
  }
}

function writeDiskCache(models: any[], fetchedAt: number): void {
  try {
    ensureBossmodeDir();
    writePrivateJsonAtomic(cachePath(), {
      models,
      fetchedAt,
      updatedAt: new Date(fetchedAt).toISOString(),
    });
  } catch (err) {
    logger.warn("catalog", "failed to write remote catalog cache", { error: String(err) });
  }
}

/** Offline hydrate: load last-good remote from disk into memory (no network). Idempotent. */
export function hydrateCatalogFromDisk(): void {
  if (remoteModels && remoteModels.length > 0) return;
  const cached = readDiskCache();
  if (!cached) return;
  remoteModels = cached.models;
  remoteFetchedAt = cached.fetchedAt;
  logger.info("catalog", "hydrated remote catalog from disk", {
    modelCount: cached.models.length,
    fetchedAt: cached.updatedAt,
  });
}

/**
 * Read-through catalog. Always returns an answer.
 * Priority: test override → remote overlay → bundled loader.
 */
export function getCatalog(): CatalogSnapshot {
  if (testModels) {
    return {
      models: testModels,
      source: "remote",
      fetchedAt: remoteFetchedAt,
      fetchedAtIso: remoteFetchedAt ? new Date(remoteFetchedAt).toISOString() : null,
      modelCount: testModels.length,
    };
  }
  if (remoteModels && remoteModels.length > 0) {
    return {
      models: remoteModels,
      source: "remote",
      fetchedAt: remoteFetchedAt,
      fetchedAtIso: remoteFetchedAt ? new Date(remoteFetchedAt).toISOString() : null,
      modelCount: remoteModels.length,
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
 * Install a successful remote overlay (memory + disk). Only call on verified success.
 * Never used for failure paths.
 */
export function commitRemoteCatalog(models: any[], fetchedAt: number = Date.now()): void {
  if (!Array.isArray(models) || models.length === 0) {
    logger.warn("catalog", "commitRemoteCatalog ignored empty models");
    return;
  }
  remoteModels = models;
  remoteFetchedAt = fetchedAt;
  writeDiskCache(models, fetchedAt);
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

/** Test/reset helper — clears in-memory remote (does not delete disk). */
export function clearRemoteCatalogMemoryForTests(): void {
  remoteModels = null;
  remoteFetchedAt = null;
}

/** Test helper — seed memory overlay without disk write. */
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
