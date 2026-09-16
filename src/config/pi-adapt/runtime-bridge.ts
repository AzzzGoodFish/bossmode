// pi SDK runtime bridge (config's marked adapter zone, P5).
// Owns the pi-coding-agent / pi-ai facing runtime, credential store and config export.
export type { AuthInteraction } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import type { ModelCredentialProfile, ModelOption, AvailableModelOption, PublicModelCredentialProfile } from "../../kernel/types.js";
import { getBossmodeDir } from "../config.js";
import { logger } from "../../kernel/logger.js";
import { DUMMY_API_KEY, hasCompleteOAuthCredentials, getModelCredentialProfile, profileModifications, sanitizeProfile, loadModelCredentialProfiles, now, sanitizeOAuthCredentials, isNewerOAuthCredential, credentialRepository, shouldUseSdkBuiltinCatalog, normalizeRuntimeBaseUrl, getCatalogStatus, type OAuthCredentials } from "../model-credentials.js";
import { createDatabaseModelsStore, getProviderOverlays, commitProviderOverlays, type ProviderModelsStoreEntry } from "../model-catalog.js";
export function getBossmodePiRuntimeRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}

/** Fixed-profile store for sessions, OAuth login and profile mutations. */
class ProfileCredentialStore implements CredentialStore {
  constructor(private readonly profileId: string, private readonly providerSlug: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== this.providerSlug) return undefined;
    const profile = getModelCredentialProfile(this.profileId);
    if (!profile || !profile.enabled || profile.providerSlug !== this.providerSlug) return undefined;
    return authEntry(profile) as Credential | undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(this.providerSlug);
    return credential ? [{ providerId: this.providerSlug, type: credential.type }] : [];
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    if (providerId !== this.providerSlug) return undefined;
    const previous = profileModifications.get(this.profileId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    profileModifications.set(this.profileId, pending);
    await previous;
    try {
      const repo = credentialRepository();
      const { profile, revision } = repo.snapshot(this.profileId);
      const current = profile?.enabled && profile.providerSlug === this.providerSlug ? authEntry(profile) as Credential | undefined : undefined;
      const next = await fn(current);
      if (revision === null) return this.read(providerId);
      if (next?.type === "oauth") {
        const { type: _type, ...oauth } = next as { type: "oauth" } & OAuthCredentials;
        if (hasCompleteOAuthCredentials(oauth)) {
          if (!isNewerOAuthCredential(oauth, profile?.oauthCredentials)) return this.read(providerId);
          if (!repo.updateSecretIfRevision(this.profileId, this.providerSlug, revision, { oauthCredentials: sanitizeOAuthCredentials(oauth) }, now())) return this.read(providerId);
        }
      } else if (next?.type === "api_key" && typeof next.key === "string" && next.key.length > 0) {
        if (!repo.updateSecretIfRevision(this.profileId, this.providerSlug, revision, { apiKey: next.key }, now())) return this.read(providerId);
      }
      // SDK contract: undefined from fn leaves the entry unchanged.
      return next ?? current;
    } finally {
      if (profileModifications.get(this.profileId) === pending) profileModifications.delete(this.profileId);
      release();
    }
  }

  async delete(_providerId: string): Promise<void> {
    // No-op: credential lifecycle is owned by bossmode's profile store.
  }
}

/** Profile-scoped store (OAuth login / profile mutation). */
export function createCredentialStore(profile: Pick<ModelCredentialProfile, "id" | "providerSlug">): CredentialStore {
  return new ProfileCredentialStore(profile.id, profile.providerSlug);
}

export function normalizeModelRef(modelRef: string): string {
  const aliases: Record<string, string> = {
    sonnet: "anthropic/claude-sonnet-4-6",
    haiku: "anthropic/claude-haiku-4-5",
    opus: "anthropic/claude-opus-4-6",
  };
  return aliases[modelRef.toLowerCase()] || modelRef;
}

export function listConfiguredModels(): ModelOption[] {
  return loadModelCredentialProfiles()
    .filter((p) => p.enabled)
    .filter((p) => p.authType !== "oauth" || hasCompleteOAuthCredentials(p.oauthCredentials))
    .flatMap((p) => p.models.map((m) => ({
      ref: `${p.providerSlug}/${m.id}`,
      providerSlug: p.providerSlug,
      modelId: m.id,
      displayName: m.name,
      profileId: p.id,
      profileName: p.name,
      profileBaseUrl: p.baseUrl,
      protocol: p.protocol,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      reasoning: m.reasoning,
      input: m.input,
      metadataSource: m.metadataSource,
      credentialStatus: p.authType === "none" ? "no_auth" : p.authType === "ambient" ? "ambient" : (p.apiKey || p.oauthCredentials ? "configured" : "missing"),
    })));
}

function modelOptionFromProfile(profile: ModelCredentialProfile, model: any): AvailableModelOption {
  const modelId = String(model.id);
  return {
    ref: `${profile.providerSlug}/${modelId}`,
    provider: profile.providerSlug,
    providerSlug: profile.providerSlug,
    providerDisplayName: profile.name,
    modelId,
    displayName: model.name,
    profileId: profile.id,
    profileName: profile.name,
    profileBaseUrl: profile.baseUrl,
    protocol: profile.protocol,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: Array.isArray(model.input) ? model.input : undefined,
    images: Array.isArray(model.input) ? model.input.includes("image") : false,
    metadataSource: "pi_catalog",
    credentialStatus: profile.authType === "none" ? "no_auth" : profile.authType === "ambient" ? "ambient" : "configured",
  };
}

export interface RuntimeCredentialResolution {
  profile: ModelCredentialProfile;
  providerSlug: string;
  providerConfig?: Record<string, unknown>;
  authEntry?: unknown;
}

export function resolveRuntimeCredential(profileId: string): RuntimeCredentialResolution {
  const profile = getModelCredentialProfile(profileId);
  if (!profile) throw new Error(`Model credential profile not found: ${profileId}`);
  if (!profile.enabled) throw new Error(`Model credential profile is disabled: ${profile.name}`);
  const auth = authEntry(profile);
  if ((profile.authType === "api_key" || profile.authType === "oauth" || profile.authType === "none") && !auth) {
    throw new Error(`Model credential projection is incomplete for provider ${profile.providerSlug}`);
  }
  return {
    profile,
    providerSlug: profile.providerSlug,
    providerConfig: shouldUseSdkBuiltinCatalog(profile) ? undefined : piProviderConfig(profile),
    authEntry: auth,
  };
}

export function listAvailableModels(): AvailableModelOption[] {
  return loadModelCredentialProfiles()
    .filter((p) => p.enabled)
    .filter((p) => p.authType !== "oauth" || hasCompleteOAuthCredentials(p.oauthCredentials))
    .flatMap((profile) => profile.models.map((model) => modelOptionFromProfile(profile, model)));
}

function runtimeProviderApiKey(profile: ModelCredentialProfile): string | undefined {
  if (profile.authType === "api_key") return profile.apiKey;
  if (profile.authType === "oauth" && hasCompleteOAuthCredentials(profile.oauthCredentials)) return String((profile.oauthCredentials as any).access);
  if (profile.authType === "none") return DUMMY_API_KEY;
  return undefined;
}

function piProviderConfig(profile: ModelCredentialProfile): Record<string, unknown> {
  const normalizedBaseUrl = normalizeRuntimeBaseUrl(profile, profile.baseUrl || "");
  return {
    baseUrl: normalizedBaseUrl,
    api: apiForProfile(profile),
    apiKey: runtimeProviderApiKey(profile),
    ...(profile.authHeader ? { authHeader: true } : {}),
    ...(profile.headers ? { headers: profile.headers } : {}),
    models: profile.models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      contextWindow: m.contextWindow ?? 128000,
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      input: m.input ?? ["text"],
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      ...(m.compat ? { compat: m.compat } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
}

function authEntry(profile: ModelCredentialProfile): unknown | undefined {
  if (profile.authType === "api_key") return { type: "api_key", key: profile.apiKey };
  if (profile.authType === "oauth") {
    if (!hasCompleteOAuthCredentials(profile.oauthCredentials)) throw new Error(`OAuth credential is incomplete for provider ${profile.providerSlug}`);
    return { type: "oauth", ...profile.oauthCredentials };
  }
  if (profile.authType === "none") return { type: "api_key", key: DUMMY_API_KEY };
  return undefined;
}

function apiForProfile(profile: ModelCredentialProfile): string {
  return profile.protocol;
}

export interface PiCredentialExport {
  agentDir: string;
  extensionPaths: string[];
  profile?: PublicModelCredentialProfile;
}

export function resolveCredentialProfileForModel(args: { modelRef: string; credentialId?: string }): ModelCredentialProfile | null {
  if (!args.credentialId) return null;
  const profiles = loadModelCredentialProfiles().filter((p) => p.enabled);
  const profile = profiles.find((p) => p.id === args.credentialId);
  if (!profile) return null;
  const modelId = args.modelRef.includes("/") ? args.modelRef.split("/").slice(1).join("/") : args.modelRef;
  if (!profile.models.some((m) => m.id === modelId)) {
    const status = getCatalogStatus();
    logger.warn("catalog", "credential profile does not include model", {
      modelRef: args.modelRef,
      modelId,
      profileId: profile.id,
      profileName: profile.name,
      profileModelCount: profile.models.length,
      catalogSource: status.source,
      catalogFetchedAt: status.fetchedAtIso,
      catalogModelCount: status.modelCount,
    });
    throw new Error(`Credential profile ${profile.name} does not include model ${modelId}`);
  }
  return profile;
}

/** Shared availability check used by member picker, PATCH validation, and setModel. */
export function isModelAvailable(modelRef: string): boolean {
  return listAvailableModels().some((m) => m.ref === modelRef);
}

export function assertModelAvailable(modelRef: string, context: string): void {
  if (isModelAvailable(modelRef)) return;
  const status = getCatalogStatus();
  logger.warn("catalog", "model not available", {
    context,
    modelRef,
    catalogSource: status.source,
    catalogFetchedAt: status.fetchedAtIso,
    catalogModelCount: status.modelCount,
    availableCount: listAvailableModels().length,
  });
  throw new Error(`Model is not available or credential is missing: ${modelRef}`);
}

/** Internal SDK provider definition. API/OAuth tokens come from the fixed-profile store;
 * custom transport headers are secret-bearing and must stay inside the runtime. */
function piProviderCatalogEntry(profile: ModelCredentialProfile): Record<string, unknown> | undefined {
  if (shouldUseSdkBuiltinCatalog(profile)) return undefined;
  const full = piProviderConfig(profile);
  const { apiKey: _apiKey, ...rest } = full as Record<string, unknown> & { apiKey?: unknown };
  return rest;
}

function mergeProviderCatalogEntries(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const aModels = Array.isArray(a.models) ? (a.models as any[]) : [];
  const bModels = Array.isArray(b.models) ? (b.models as any[]) : [];
  const byId = new Map<string, any>();
  for (const m of aModels) if (m?.id) byId.set(String(m.id), m);
  for (const m of bModels) if (m?.id) byId.set(String(m.id), m);
  // Prefer `b` (later / preferred profile) for endpoint fields.
  return { ...a, ...b, models: Array.from(byId.values()) };
}

/** Internal provider map for in-memory SDK registration; never a public DTO. */
export function buildAllProvidersCatalog(preferredProfileId?: string): Record<string, Record<string, unknown>> {
  const providers: Record<string, Record<string, unknown>> = {};
  const profiles = loadModelCredentialProfiles().filter((p) => p.enabled);
  // Write non-preferred first, preferred last so its endpoint wins on slug collision.
  const ordered = [
    ...profiles.filter((p) => p.id !== preferredProfileId),
    ...profiles.filter((p) => p.id === preferredProfileId),
  ];
  for (const profile of ordered) {
    const entry = piProviderCatalogEntry(profile);
    if (!entry) continue;
    const slug = profile.providerSlug;
    providers[slug] = providers[slug] ? mergeProviderCatalogEntries(providers[slug], entry) : entry;
  }
  return providers;
}


const databaseRuntimeProviders = new WeakMap<ModelRuntime, Set<string>>();

/** Supported SDK construction with DB catalog/credentials, no generated config files. */
export async function createDatabaseModelRuntime(credentials: CredentialStore, preferredProfileId?: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: createDatabaseModelsStore(), allowModelNetwork: false });
  await refreshDatabaseModelRuntime(runtime, preferredProfileId);
  return runtime;
}

/** Re-register only Bossmode-managed provider definitions; extension registrations stay owned by extensions. */
export async function refreshDatabaseModelRuntime(runtime: ModelRuntime, preferredProfileId?: string): Promise<void> {
  const providers = buildAllProvidersCatalog(preferredProfileId);
  for (const id of databaseRuntimeProviders.get(runtime) ?? []) {
    if (!(id in providers)) runtime.unregisterProvider(id);
  }
  for (const [id, config] of Object.entries(providers)) {
    runtime.registerProvider(id, config as Parameters<ModelRuntime["registerProvider"]>[1]);
  }
  databaseRuntimeProviders.set(runtime, new Set(Object.keys(providers)));
  await runtime.refresh({ allowNetwork: false });
}

/** Build pi ModelsStoreEntry map from flat catalog + per-provider fetch metadata. */
export function buildProviderOverlaysFromFetch(
  models: any[],
  fetchMeta: Map<string, { lastModified: number; etag?: string; models: any[] }>,
  fetchedAt: number,
): Record<string, ProviderModelsStoreEntry> {
  const byProvider = new Map<string, any[]>();
  for (const m of models) {
    const p = m?.provider ? String(m.provider) : "";
    if (!p) continue;
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p)!.push(m);
  }
  const out: Record<string, ProviderModelsStoreEntry> = {};
  for (const [providerId, providerModels] of byProvider) {
    const meta = fetchMeta.get(providerId);
    // Prefer fetch-time models for that provider when available (exact remote shard).
    const modelsForEntry = meta?.models?.length ? meta.models : providerModels;
    let lastModified = meta?.lastModified && meta.lastModified > 0 ? meta.lastModified : fetchedAt;
    // Must beat pi's builtinModelDataGeneratedAt or remoteModels() returns [].
    if (!lastModified || lastModified <= 0) lastModified = Date.now();
    out[providerId] = {
      models: modelsForEntry,
      lastModified,
      checkedAt: fetchedAt,
      ...(meta?.etag ? { etag: meta.etag } : {}),
    };
  }
  return out;
}

/** Catalog distribution uses native DB-backed SDK adapters, never generated JSON files. */
export function distributeModelsStoreOverlays(
  overlays: Record<string, ProviderModelsStoreEntry> = getProviderOverlays(),
): { dirs: number; written: number } {
  commitProviderOverlays(overlays);
  void refreshLiveInstanceModelRegistries().catch(() => {
    logger.warn("catalog", "live registry refresh failed");
  });
  return { dirs: 0, written: 0 };
}

async function refreshLiveInstanceModelRegistries(): Promise<void> {
  try {
    const { refreshAllInstanceModelRegistries } = await import("../../agent/orchestrator/agent-manager.js");
    if (typeof refreshAllInstanceModelRegistries === "function") {
      await refreshAllInstanceModelRegistries();
    }
  } catch (err) {
    logger.warn("catalog", "could not refresh live instance registries", { error: String(err) });
  }
}

function safeFsSegment(s: string): string {
  return String(s || "_").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** pi agentDir for a scope (room or DM). */
export function resolvePiAgentDir(roomIdOrScope: string, memberIdOrName: string): string {
  const safeMember = safeFsSegment(memberIdOrName);
  const root = getBossmodePiRuntimeRoot();
  if (typeof roomIdOrScope === "string" && roomIdOrScope.startsWith("dm:")) {
    return join(root, "members", safeMember, "dm");
  }
  return join(root, safeFsSegment(roomIdOrScope), safeMember);
}

export function exportPiConfigForMember(args: {
  roomId: string;
  memberName: string;
  modelRef: string;
  credentialId?: string;
}): PiCredentialExport | null {
  const profile = resolveCredentialProfileForModel({ modelRef: args.modelRef, credentialId: args.credentialId });
  if (!profile) return null;

  const agentDir = resolvePiAgentDir(args.roomId, args.memberName);
  mkdirSync(agentDir, { recursive: true });

  // Parent runtime registers buildAllProvidersCatalog(profile.id) in memory and
  // passes createDatabaseModelsStore(); agentDir is retained for SDK sessions/assets.
  return { agentDir, extensionPaths: [], profile: sanitizeProfile(profile) };
}
