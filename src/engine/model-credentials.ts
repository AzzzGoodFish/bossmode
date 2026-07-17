import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthInteraction, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { getBossmodeDir, ensureBossmodeDir } from "../shared/config.js";
import type {
  ModelCredentialProfile,
  ModelCredentialProfileInput,
  PublicModelCredentialProfile,
  ModelOption,
  ModelProtocol,
  ModelAuthType,
  ModelRequestProfile,
  ModelCredentialProfileKind,
  ModelDefinitionConfig,
  AvailableModelOption,
  PublicModelProvider,
  ConnectApiKeyRequest,
  StartOAuthConnectionRequest,
  OAuthLoginJobPublic,
  OAuthLoginJobStatus,
  OAuthDeviceCodeInfo,
  OAuthSelectPrompt,
} from "../shared/types.js";

const STORE_FILE = "model-credentials.json";
// SDK/provider adapters currently require an apiKey-shaped value even for keyless endpoints.
// This sentinel is not a credential; it marks authType=none until upstream supports true no-auth providers.
const DUMMY_API_KEY = "__bossmode_no_auth__";

export const MODEL_PROTOCOLS: ModelProtocol[] = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "azure-openai-responses",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
];

const AUTH_TYPES: ModelAuthType[] = ["api_key", "oauth", "none", "ambient"];
const REQUEST_PROFILES: ModelRequestProfile[] = ["standard", "openai_codex_subscription"];
const PROFILE_KINDS: ModelCredentialProfileKind[] = ["builtin_provider", "custom_endpoint", "trusted_adapter"];
const OAUTH_PROVIDERS = ["anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"] as const;
const BUILTIN_API_KEY_PROVIDERS = new Set(["anthropic", "openai", "xai", "openrouter", "google", "mistral", "deepseek", "groq", "cerebras", "zai", "moonshotai", "moonshotai-cn", "minimax", "minimax-cn", "huggingface", "fireworks", "together", "kimi-coding"]);
const MIGRATION_CUSTOM_ENDPOINT_VISION_V1 = "custom-endpoint-vision-v1";

type ModelCredentialStore = { profiles: ModelCredentialProfile[]; migrations: string[] };
type OAuthJobStatus = OAuthLoginJobStatus;

type OAuthCredentials = { refresh: string; access: string; expires: number; [key: string]: unknown };
type OAuthInputWaiter = { resolve: (value: string) => void; reject: (error: Error) => void };
type OAuthLoginCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onDeviceCode: (deviceCode: OAuthDeviceCodeInfo) => void;
  onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
};

interface OAuthLoginAdapter {
  login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}

type ModelDiscoveredMetadata = {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: ModelDefinitionConfig["thinkingLevelMap"];
  compat?: ModelDefinitionConfig["compat"];
};

type OAuthLoginJob = OAuthLoginJobPublic & {
  profileInput: ModelCredentialProfileInput & { id?: string };
  inputWaiter?: OAuthInputWaiter;
  abortController: AbortController;
  ready: Promise<void>;
  resolveReady: () => void;
  loginPromise: Promise<void>;
};

const oauthJobs = new Map<string, OAuthLoginJob>();
let oauthLoginAdapter: OAuthLoginAdapter | null = null;
let piCatalogModelsForTests: any[] | null = null;

function now(): number { return Date.now(); }
function storePath(): string { return join(getBossmodeDir(), STORE_FILE); }

export function getBossmodePiRuntimeRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}

function writePrivateJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function readStore(): ModelCredentialStore {
  const path = storePath();
  if (!existsSync(path)) return { profiles: [], migrations: [] };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { profiles?: ModelCredentialProfile[]; migrations?: string[] };
  const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  return {
    profiles: rawProfiles.map(normalizeStoredRequestProfile),
    migrations: Array.isArray(parsed.migrations) ? parsed.migrations.filter((m): m is string => typeof m === "string") : [],
  };
}

// Legacy "Claude Code fingerprint" request profiles were removed; fold them back to standard.
function normalizeStoredRequestProfile(profile: ModelCredentialProfile): ModelCredentialProfile {
  const legacy = profile.requestProfile as string;
  if (legacy === "anthropic_claude_code_oauth" || legacy === "anthropic_proxy_claude_code") {
    return { ...profile, requestProfile: "standard" };
  }
  return profile;
}

function writeStore(profiles: ModelCredentialProfile[], migrations?: string[]): void {
  ensureBossmodeDir();
  const existingMigrations = migrations ?? readStore().migrations;
  writePrivateJson(storePath(), { profiles, ...(existingMigrations.length ? { migrations: existingMigrations } : {}) });
}

function sanitizeProfile(profile: ModelCredentialProfile): PublicModelCredentialProfile {
  const { apiKey: _apiKey, oauthCredentials: _oauthCredentials, ...rest } = profile;
  const catalogModels = isBuiltinProviderProfile(profile)
    ? applyBuiltinMetadataOverrides(modelsForBuiltinProvider(profile.providerSlug, profile.baseUrl), profile.modelCustomizations)
    : undefined;
  const addedModels = isBuiltinProviderProfile(profile) ? profile.modelCustomizations?.addedModels : undefined;
  return {
    ...rest,
    hasSecret: !!profile.apiKey || !!profile.oauthCredentials,
    modelRefs: profile.models.map((m) => `${profile.providerSlug}/${m.id}`),
    ...(catalogModels ? { catalogModels } : {}),
    ...(addedModels && addedModels.length > 0 ? { addedModels } : {}),
  };
}

function validateSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) throw new Error("Invalid provider slug");
}

function validateBaseUrl(baseUrl: string | undefined, authType: ModelAuthType): void {
  if (authType === "ambient") return;
  if (!baseUrl) throw new Error("baseUrl is required");
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error("baseUrl must be an http:// or https:// URL");
  }
}

function normalizeOptionalBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  validateBaseUrl(trimmed, "api_key");
  return trimmed;
}

function validateModel(model: ModelDefinitionConfig): ModelDefinitionConfig {
  if (!model.id?.trim()) throw new Error("model id is required");
  if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) throw new Error("contextWindow must be a positive integer");
  if (model.maxTokens !== undefined && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) throw new Error("maxTokens must be a positive integer");
  const input = model.input?.length ? model.input : undefined;
  const { input: _input, ...rest } = model;
  return {
    ...rest,
    id: model.id.trim(),
    name: model.name?.trim() || undefined,
    ...(input ? { input } : {}),
    ...modelSdkMetadata(model),
    metadataSource: model.metadataSource || (model.contextWindow || model.maxTokens || model.reasoning !== undefined ? "endpoint" : "unknown"),
  };
}

function validateOverrideValue(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function hasModelCustomizations(profile: Pick<ModelCredentialProfile, "modelCustomizations">): boolean {
  const disabled = profile.modelCustomizations?.disabled || [];
  const overrides = profile.modelCustomizations?.contextWindowOverride || {};
  const addedModels = profile.modelCustomizations?.addedModels || [];
  return disabled.length > 0 || Object.keys(overrides).length > 0 || addedModels.length > 0;
}

function sanitizeModelCustomizations(customizations: ModelCredentialProfile["modelCustomizations"] | undefined, catalogModels: ModelDefinitionConfig[]): ModelCredentialProfile["modelCustomizations"] | undefined {
  const catalogById = new Map(catalogModels.map((m) => [m.id, m]));
  const disabled = Array.from(new Set((customizations?.disabled || []).filter((id) => catalogById.has(id))));
  const overrides: Record<string, number> = {};
  for (const [id, value] of Object.entries(customizations?.contextWindowOverride || {})) {
    if (!catalogById.has(id)) continue;
    const contextWindow = validateOverrideValue(value, "contextWindow");
    if (contextWindow !== undefined) overrides[id] = contextWindow;
  }
  // Auto-reconcile: if the pi catalog later adds a model matching a previously
  // added custom model's id, the catalog entry wins and the custom one is silently
  // dropped here rather than shown twice or erroring on unrelated saves/reloads.
  const addedModels = Array.from(
    new Map(
      (customizations?.addedModels || [])
        .filter((m) => m.id?.trim() && !catalogById.has(m.id.trim()))
        .map(validateModel)
        .map((m) => [m.id, m] as const),
    ).values(),
  );
  return disabled.length > 0 || Object.keys(overrides).length > 0 || addedModels.length > 0
    ? {
        ...(disabled.length ? { disabled } : {}),
        ...(Object.keys(overrides).length ? { contextWindowOverride: overrides } : {}),
        ...(addedModels.length ? { addedModels } : {}),
      }
    : undefined;
}

function deriveBuiltinModelCustomizations(inputModels: ModelDefinitionConfig[] | undefined, catalogModels: ModelDefinitionConfig[]): ModelCredentialProfile["modelCustomizations"] | undefined {
  if (!inputModels) return undefined;
  const inputById = new Map(inputModels.filter((m) => m.id?.trim()).map((m) => [m.id.trim(), m]));
  const disabled = catalogModels.filter((m) => !inputById.has(m.id)).map((m) => m.id);
  const overrides: Record<string, number> = {};
  for (const catalog of catalogModels) {
    const input = inputById.get(catalog.id);
    if (!input) continue;
    const contextWindow = validateOverrideValue(input.contextWindow, "contextWindow");
    if (contextWindow !== undefined && contextWindow !== catalog.contextWindow) overrides[catalog.id] = contextWindow;
  }
  return sanitizeModelCustomizations({ disabled, contextWindowOverride: overrides }, catalogModels);
}

function applyBuiltinMetadataOverrides(catalogModels: ModelDefinitionConfig[], customizations?: ModelCredentialProfile["modelCustomizations"]): ModelDefinitionConfig[] {
  const overrides = customizations?.contextWindowOverride || {};
  return catalogModels.map((m) => ({
    ...m,
    ...(overrides[m.id] !== undefined ? { contextWindow: overrides[m.id], metadataSource: "endpoint" as const } : {}),
  }));
}

function applyBuiltinModelCustomizations(catalogModels: ModelDefinitionConfig[], customizations?: ModelCredentialProfile["modelCustomizations"]): ModelDefinitionConfig[] {
  const disabled = new Set(customizations?.disabled || []);
  return applyBuiltinMetadataOverrides(catalogModels, customizations).filter((m) => !disabled.has(m.id));
}

/** The full effective model set for a built-in provider profile: enabled catalog models plus any user-added custom models. */
function materializeBuiltinModels(catalogModels: ModelDefinitionConfig[], customizations?: ModelCredentialProfile["modelCustomizations"]): ModelDefinitionConfig[] {
  return [...applyBuiltinModelCustomizations(catalogModels, customizations), ...(customizations?.addedModels || [])];
}

function validateOAuthProvider(providerId: string | undefined): string {
  const value = providerId || "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error("Unsupported OAuth provider");
  if (!oauthProviderIds().has(value)) throw new Error("Unsupported OAuth provider");
  return value;
}

function hasCompleteOAuthCredentials(value: unknown): value is OAuthCredentials {
  const c = value as Partial<OAuthCredentials> | undefined;
  return !!c && typeof c.access === "string" && c.access.length > 0 && typeof c.refresh === "string" && c.refresh.length > 0 && typeof c.expires === "number";
}

function sanitizeOAuthCredentials(credentials: OAuthCredentials): OAuthCredentials {
  return { ...credentials, access: credentials.access, refresh: credentials.refresh, expires: credentials.expires };
}

function isNewerOAuthCredential(candidate: OAuthCredentials, current: unknown): boolean {
  if (!hasCompleteOAuthCredentials(current)) return true;
  return candidate.expires > current.expires;
}

function credentialChanged(a: OAuthCredentials | undefined, b: OAuthCredentials): boolean {
  if (!a) return true;
  return a.access !== b.access || a.refresh !== b.refresh || a.expires !== b.expires || JSON.stringify(a) !== JSON.stringify(b);
}

export function persistOAuthCredentialsForProfile(profileId: string, providerSlug: string, credentials: OAuthCredentials): ModelCredentialProfile | null {
  const store = readStore();
  let updated: ModelCredentialProfile | null = null;
  const next = store.profiles.map((profile) => {
    if (profile.id !== profileId || profile.providerSlug !== providerSlug || profile.authType !== "oauth") return profile;
    if (!isNewerOAuthCredential(credentials, profile.oauthCredentials)) {
      updated = profile;
      return profile;
    }
    if (!credentialChanged(profile.oauthCredentials as OAuthCredentials | undefined, credentials)) {
      updated = profile;
      return profile;
    }
    updated = { ...profile, oauthCredentials: sanitizeOAuthCredentials(credentials), updatedAt: now() };
    return updated;
  });
  if (updated) writeStore(next);
  return updated;
}

function persistApiKeyForProfile(profileId: string, providerSlug: string, apiKey: string): ModelCredentialProfile | null {
  const store = readStore();
  const index = store.profiles.findIndex((p) => p.id === profileId);
  if (index < 0) return null;
  const existing = store.profiles[index];
  if (existing.providerSlug !== providerSlug || existing.authType !== "api_key") return existing;
  if (existing.apiKey === apiKey) return existing;
  const next = { ...existing, apiKey, updatedAt: now() };
  store.profiles[index] = next;
  writeStore(store.profiles, store.migrations);
  return next;
}

class BossmodeCredentialStore implements CredentialStore {
  constructor(private readonly profileId: string, private readonly providerSlug: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== this.providerSlug) return undefined;
    const profile = getModelCredentialProfile(this.profileId);
    if (!profile) return undefined;
    return authEntry(profile) as Credential | undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(this.providerSlug);
    return credential ? [{ providerId: this.providerSlug, type: credential.type }] : [];
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    if (providerId !== this.providerSlug) return fn(undefined);
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next?.type === "oauth") {
      const { type: _type, ...oauth } = next as { type: "oauth" } & OAuthCredentials;
      if (hasCompleteOAuthCredentials(oauth)) persistOAuthCredentialsForProfile(this.profileId, this.providerSlug, oauth);
    } else if (next?.type === "api_key" && typeof (next as any).key === "string" && (next as any).key.length > 0) {
      persistApiKeyForProfile(this.profileId, this.providerSlug, (next as any).key);
    }
    return next;
  }

  async delete(_providerId: string): Promise<void> {
    // No-op: credential lifecycle is owned by bossmode's profile store
    // (deleteModelCredentialProfile), not by the SDK's credential store.
  }
}

export function createCredentialStore(profile: Pick<ModelCredentialProfile, "id" | "providerSlug">): CredentialStore {
  return new BossmodeCredentialStore(profile.id, profile.providerSlug);
}

function sanitizeOAuthJob(job: OAuthLoginJob): OAuthLoginJobPublic {
  return {
    id: job.id,
    status: job.status,
    providerId: job.providerId,
    authUrl: job.authUrl,
    userCode: job.userCode,
    deviceCode: job.deviceCode,
    selectPrompt: job.selectPrompt,
    prompt: job.prompt,
    error: job.error,
    profileId: job.profileId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function inferProfileKind(input: Partial<ModelCredentialProfileInput>, existing?: ModelCredentialProfile): ModelCredentialProfileKind {
  const kind = input.profileKind ?? existing?.profileKind ?? "custom_endpoint";
  if (!PROFILE_KINDS.includes(kind)) throw new Error("Unsupported profile kind");
  return kind;
}

function validateUniqueModels(models: ModelDefinitionConfig[]): void {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
}

function validateInput(input: ModelCredentialProfileInput, existing?: ModelCredentialProfile, options: { allowIncompleteOAuth?: boolean } = {}): ModelCredentialProfileInput & { models: ModelDefinitionConfig[]; profileKind: ModelCredentialProfileKind } {
  if (!input.name?.trim()) throw new Error("name is required");
  validateSlug(input.providerSlug || "");
  if (!AUTH_TYPES.includes(input.authType)) throw new Error("Unsupported auth type");
  const profileKind = inferProfileKind(input, existing);
  const requestProfile = input.requestProfile || "standard";
  if (!REQUEST_PROFILES.includes(requestProfile)) throw new Error("Unsupported request profile");

  if (profileKind === "builtin_provider") {
    const builtin = getBuiltinProvider(input.providerSlug);
    if (!builtin) throw new Error(`Unsupported built-in provider: ${input.providerSlug}`);
    if (input.authType !== "api_key" && input.authType !== "oauth") throw new Error("Built-in providers support api_key or oauth auth only");
    if (!builtin.authModes.includes(input.authType as "api_key" | "oauth")) throw new Error(`Provider ${input.providerSlug} does not support ${input.authType}`);
    if (input.authType === "api_key" && !input.apiKey && !existing?.apiKey) throw new Error("apiKey is required");
    if (input.authType === "oauth") {
      validateOAuthProvider(input.oauthProviderId || input.providerSlug);
      const credentials = input.oauthCredentials ?? existing?.oauthCredentials;
      if (!options.allowIncompleteOAuth && !hasCompleteOAuthCredentials(credentials)) throw new Error("OAuth credential is incomplete; complete login before saving");
    }
    const baseUrlOverride = input.authType === "api_key" ? normalizeOptionalBaseUrl(input.baseUrl) : undefined;
    const catalogModels = modelsForBuiltinProvider(input.providerSlug, baseUrlOverride);
    if (catalogModels.length === 0) throw new Error(`No built-in models found for provider: ${input.providerSlug}`);
    if (input.modelCustomizations !== undefined) {
      const catalogIds = new Set(catalogModels.map((m) => m.id));
      const addedIds = new Set<string>();
      for (const added of input.modelCustomizations.addedModels || []) {
        const id = added.id?.trim();
        if (!id) continue;
        if (catalogIds.has(id)) throw new Error(`Model "${id}" is already in the provider catalog.`);
        if (addedIds.has(id)) throw new Error(`Duplicate model id: ${id}`);
        addedIds.add(id);
      }
    }
    const modelCustomizations = input.modelCustomizations !== undefined
      ? sanitizeModelCustomizations(input.modelCustomizations, catalogModels)
      : input.models
        ? deriveBuiltinModelCustomizations(input.models, catalogModels)
        : sanitizeModelCustomizations(existing?.modelCustomizations, catalogModels);
    const models = materializeBuiltinModels(catalogModels, modelCustomizations);
    if (models.length === 0) throw new Error("at least one model must remain visible");
    validateUniqueModels(models);
    return {
      ...input,
      profileKind,
      name: input.name.trim(),
      providerSlug: input.providerSlug.trim(),
      protocol: protocolForBuiltinProvider(input.providerSlug),
      baseUrl: baseUrlForBuiltinProvider(input.providerSlug, baseUrlOverride),
      requestProfile,
      models,
      modelCustomizations,
    };
  }

  if (!MODEL_PROTOCOLS.includes(input.protocol)) throw new Error("Unsupported protocol");
  validateBaseUrl(input.baseUrl, input.authType);
  if (input.authType === "api_key" && !input.apiKey && !existing?.apiKey) throw new Error("apiKey is required");
  if (input.authType === "oauth") {
    validateOAuthProvider(input.oauthProviderId);
    const credentials = input.oauthCredentials ?? existing?.oauthCredentials;
    if (!options.allowIncompleteOAuth && !hasCompleteOAuthCredentials(credentials)) throw new Error("OAuth credential is incomplete; complete login before saving");
  }
  const models = (input.models || [])
    .map(validateModel)
    .map((m) => applyPiCatalogFallback(m, input.providerSlug.trim(), loadPiCatalogModelsSync()));
  if (models.length === 0) throw new Error("at least one model is required");
  validateUniqueModels(models);
  return { ...input, profileKind, name: input.name.trim(), providerSlug: input.providerSlug.trim(), requestProfile, models };
}

export function loadModelCredentialProfiles(): ModelCredentialProfile[] {
  return refreshBuiltinProviderProfilesFromStore({ persist: true });
}

export function listPublicModelCredentialProfiles(): PublicModelCredentialProfile[] {
  return loadModelCredentialProfiles().map(sanitizeProfile);
}

export function getModelCredentialProfile(id: string): ModelCredentialProfile | null {
  return loadModelCredentialProfiles().find((p) => p.id === id) ?? null;
}

function resolveApiKeyForSave(valid: ModelCredentialProfileInput, existing?: ModelCredentialProfile): string | undefined {
  const next = valid.apiKey?.trim();
  return next ? next : existing?.apiKey;
}

export function saveModelCredentialProfile(input: ModelCredentialProfileInput & { id?: string }): PublicModelCredentialProfile {
  const profiles = loadModelCredentialProfiles();
  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined;
  const valid = validateInput(input, existing);
  const allowsDuplicateProvider = valid.profileKind === "builtin_provider";
  const duplicate = profiles.find((p) => p.providerSlug === valid.providerSlug && p.id !== input.id && (!allowsDuplicateProvider || (p.profileKind ?? "custom_endpoint") !== "builtin_provider"));
  if (duplicate) throw new Error(`Provider slug already exists: ${valid.providerSlug}`);
  const ts = now();
  const profile: ModelCredentialProfile = {
    id: input.id || randomUUID().slice(0, 8),
    profileKind: valid.profileKind,
    name: valid.name,
    providerSlug: valid.providerSlug,
    protocol: valid.protocol,
    baseUrl: valid.baseUrl,
    authType: valid.authType,
    apiKey: valid.authType === "api_key" ? resolveApiKeyForSave(valid, existing) : undefined,
    oauthProviderId: valid.authType === "oauth" ? valid.oauthProviderId : undefined,
    oauthCredentials: valid.authType === "oauth" ? (valid.oauthCredentials ?? existing?.oauthCredentials) : undefined,
    requestProfile: valid.requestProfile,
    authHeader: valid.authHeader,
    headers: valid.headers,
    enabled: valid.enabled ?? existing?.enabled ?? true,
    isDefault: valid.isDefault ?? existing?.isDefault ?? false,
    models: valid.models,
    modelCustomizations: valid.modelCustomizations,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  const replaced = existing ? profiles.map((p) => p.id === existing.id ? profile : p) : [...profiles, profile];
  const next = profile.isDefault
    ? replaced.map((p) => p.id !== profile.id && p.providerSlug === profile.providerSlug ? { ...p, isDefault: false } : p)
    : replaced;
  writeStore(next);
  return sanitizeProfile(profile);
}

function nextBuiltinProfileName(providerSlug: string, displayName: string): string {
  const existing = loadModelCredentialProfiles().filter((p) => p.providerSlug === providerSlug && (p.profileKind ?? "custom_endpoint") === "builtin_provider");
  if (existing.length === 0) return displayName;
  const used = new Set(existing.map((p) => p.name));
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${displayName} ${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${displayName} ${existing.length + 1}`;
}

export function connectBuiltinProviderApiKey(input: ConnectApiKeyRequest): PublicModelCredentialProfile {
  const providerSlug = input.providerSlug?.trim();
  validateSlug(providerSlug || "");
  if (!input.apiKey?.trim()) throw new Error("apiKey is required");
  const provider = getBuiltinProvider(providerSlug);
  if (!provider) throw new Error(`Unsupported built-in provider: ${providerSlug}`);
  if (!provider.authModes.includes("api_key")) throw new Error(`Provider ${providerSlug} does not support API key auth`);

  const baseUrlOverride = normalizeOptionalBaseUrl(input.baseUrlOverride);
  const hasExistingSameProviderProfile = loadModelCredentialProfiles().some((p) => p.providerSlug === providerSlug && (p.profileKind ?? "custom_endpoint") === "builtin_provider");
  return saveModelCredentialProfile({
    profileKind: "builtin_provider",
    name: input.name?.trim() || nextBuiltinProfileName(providerSlug, provider.displayName),
    providerSlug,
    protocol: protocolForBuiltinProvider(providerSlug),
    baseUrl: baseUrlForBuiltinProvider(providerSlug, baseUrlOverride),
    authType: "api_key",
    apiKey: input.apiKey,
    requestProfile: "standard",
    enabled: true,
    isDefault: input.isDefault ?? !hasExistingSameProviderProfile,
    models: modelsForBuiltinProvider(providerSlug, baseUrlOverride),
  });
}

export function deleteModelCredentialProfile(id: string): boolean {
  const profiles = loadModelCredentialProfiles();
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) return false;
  writeStore(next);
  return true;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function waitForOAuthInput(job: OAuthLoginJob): Promise<string> {
  if (job.status === "cancelled") return Promise.reject(new Error("OAuth login job was cancelled"));
  return new Promise<string>((resolve, reject) => { job.inputWaiter = { resolve, reject }; });
}

class PiAiOAuthLoginAdapter implements OAuthLoginAdapter {
  async login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const runtime = await ensureCatalogRegistryRuntime();
    const provider = runtime.getProviders().find((p) => p.id === providerId);
    if (!provider?.auth.oauth) {
      const supported = runtime.getProviders().filter((p) => p.auth.oauth).map((p) => p.id);
      throw new Error(`OAuth provider ${providerId} is not supported by installed pi-ai (${supported.join(", ") || "none"})`);
    }
    const interaction: AuthInteraction = {
      signal: callbacks.signal,
      notify: (event) => {
        if (event.type === "auth_url") callbacks.onAuth({ url: event.url, instructions: event.instructions });
        else if (event.type === "device_code") callbacks.onDeviceCode({ userCode: event.userCode, verificationUri: event.verificationUri, intervalSeconds: event.intervalSeconds, expiresInSeconds: event.expiresInSeconds });
        else if (event.type === "progress") callbacks.onProgress?.(event.message);
      },
      prompt: async (prompt) => {
        if (prompt.type === "select") {
          const value = await callbacks.onSelect({ message: prompt.message, options: prompt.options.map((o) => ({ id: o.id, label: o.label })) });
          if (value === undefined) throw new Error("OAuth login was cancelled");
          return value;
        }
        if (prompt.type === "manual_code") {
          if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
          return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
        }
        return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
      },
    };
    const credential = await runtime.login(providerId, "oauth", interaction);
    if (credential.type !== "oauth" || !hasCompleteOAuthCredentials(credential)) throw new Error(`OAuth provider ${providerId} did not return complete credentials`);
    const { type: _type, ...credentials } = credential;
    return credentials as OAuthCredentials;
  }
}

function getOAuthLoginAdapter(): OAuthLoginAdapter {
  if (!oauthLoginAdapter) oauthLoginAdapter = new PiAiOAuthLoginAdapter();
  return oauthLoginAdapter;
}


function mapOAuthError(err: unknown): string {
  const message = String((err as any)?.message || err || "OAuth login failed");
  if (message.includes("Failed to extract accountId from token") || message.toLowerCase().includes("invalid_grant") || message.toLowerCase().includes("refresh")) {
    return "OAuth credential is invalid or expired. 请在 Settings 重新连接。";
  }
  return message;
}

function parseDeviceCodeFromAuth(info: { url: string; instructions?: string }): OAuthDeviceCodeInfo | undefined {
  const instructions = info.instructions || "";
  const codeMatch = instructions.match(/(?:enter code|code)[:：]?\s*([A-Z0-9-]{4,})/i);
  if (!codeMatch) return undefined;
  return { userCode: codeMatch[1], verificationUri: info.url };
}

function buildNativeOAuthProfileInput(input: StartOAuthConnectionRequest): { providerId: string; profileInput: ModelCredentialProfileInput & { id?: string }; profileId?: string } {
  const providerId = validateOAuthProvider(input.providerId);
  const provider = getBuiltinProvider(providerId);
  if (!provider) throw new Error(`Unsupported built-in provider: ${providerId}`);
  if (!provider.authModes.includes("oauth")) throw new Error(`Provider ${providerId} does not support OAuth`);

  const existingById = input.profileId ? getModelCredentialProfile(input.profileId) : null;
  if (input.profileId && !existingById) throw new Error("profile not found");
  if (existingById && existingById.providerSlug !== providerId) throw new Error("profile provider does not match OAuth provider");
  const hasExistingSameProviderProfile = loadModelCredentialProfiles().some((p) => p.providerSlug === providerId && (p.profileKind ?? "custom_endpoint") === "builtin_provider");
  const existing = existingById ?? null;

  return {
    providerId,
    profileId: existing?.id,
    profileInput: {
      id: existing?.id,
      profileKind: "builtin_provider",
      name: input.name?.trim() || existing?.name || nextBuiltinProfileName(providerId, provider.displayName),
      providerSlug: providerId,
      protocol: protocolForBuiltinProvider(providerId),
      baseUrl: baseUrlForBuiltinProvider(providerId),
      authType: "oauth",
      oauthProviderId: providerId,
      requestProfile: "standard",
      enabled: existing?.enabled ?? true,
      isDefault: existing?.isDefault ?? !hasExistingSameProviderProfile,
      models: modelsForBuiltinProvider(providerId),
    },
  };
}

export function setOAuthLoginAdapterForTests(adapter: OAuthLoginAdapter | null): void {
  oauthLoginAdapter = adapter;
}

function startOAuthLogin(job: OAuthLoginJob): void {
  job.loginPromise = getOAuthLoginAdapter().login(job.providerId, {
    signal: job.abortController.signal,
    onAuth: (info) => {
      job.authUrl = info.url;
      const deviceCode = parseDeviceCodeFromAuth(info);
      if (deviceCode) {
        job.status = "awaiting_device";
        job.deviceCode = deviceCode;
        job.userCode = deviceCode.userCode;
      } else {
        job.status = "awaiting_input";
      }
      job.prompt = info.instructions || "Complete login in the opened provider page, then paste the returned code if requested.";
      job.updatedAt = now();
      job.resolveReady();
    },
    onPrompt: async (prompt) => {
      job.status = "awaiting_input";
      job.prompt = prompt.message;
      job.updatedAt = now();
      job.resolveReady();
      if (prompt.allowEmpty) return waitForOAuthInput(job).catch((err) => { throw err; });
      return waitForOAuthInput(job);
    },
    onManualCodeInput: async () => {
      job.status = "awaiting_input";
      job.prompt = "Paste the authorization code or full redirect URL.";
      job.updatedAt = now();
      job.resolveReady();
      return waitForOAuthInput(job);
    },
    onDeviceCode: (deviceCode) => {
      job.status = "awaiting_device";
      job.deviceCode = deviceCode;
      job.userCode = deviceCode.userCode;
      job.authUrl = deviceCode.verificationUri;
      job.prompt = `Open ${deviceCode.verificationUri} and enter code ${deviceCode.userCode}.`;
      job.updatedAt = now();
      job.resolveReady();
    },
    onSelect: async (prompt) => {
      job.status = "awaiting_input";
      job.selectPrompt = prompt;
      job.prompt = `${prompt.message} (${prompt.options.map((o) => o.label).join(", ")})`;
      job.updatedAt = now();
      job.resolveReady();
      return waitForOAuthInput(job);
    },
    onProgress: (message) => {
      job.prompt = message;
      job.updatedAt = now();
    },
  }).then((credentials) => {
    if (job.status === "cancelled") return;
    const saved = saveModelCredentialProfile({
      ...job.profileInput,
      id: job.profileId,
      authType: "oauth",
      oauthProviderId: job.providerId,
      oauthCredentials: sanitizeOAuthCredentials(credentials),
      apiKey: undefined,
    });
    job.status = "completed";
    job.profileId = saved.id;
    job.authUrl = undefined;
    job.userCode = undefined;
    job.prompt = "OAuth connected.";
    job.error = undefined;
    job.updatedAt = now();
    job.resolveReady();
  }).catch((err: any) => {
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.error = mapOAuthError(err);
    job.prompt = "OAuth login failed. Retry from Start login.";
    job.updatedAt = now();
    job.resolveReady();
  });
}

function createOAuthLoginJob(providerId: string, profileInput: ModelCredentialProfileInput & { id?: string }, profileId?: string): OAuthLoginJob {
  const nowTs = now();
  const ready = createDeferred();
  const job: OAuthLoginJob = {
    id: randomUUID().slice(0, 8),
    status: "starting",
    providerId,
    prompt: "Starting provider OAuth login...",
    profileId,
    createdAt: nowTs,
    updatedAt: nowTs,
    profileInput,
    abortController: new AbortController(),
    ready: ready.promise,
    resolveReady: ready.resolve,
    loginPromise: Promise.resolve(),
  };
  oauthJobs.set(job.id, job);
  startOAuthLogin(job);
  return job;
}

export async function startNativeOAuthConnection(input: StartOAuthConnectionRequest): Promise<OAuthLoginJobPublic> {
  const raw = input as StartOAuthConnectionRequest & Record<string, unknown>;
  for (const forbidden of ["profile", "baseUrl", "protocol", "models", "authType"] as const) {
    if (raw[forbidden] !== undefined) throw new Error(`OAuth connection accepts only providerId, profileId, name, and requestProfile; unexpected ${forbidden}`);
  }
  const { providerId, profileInput, profileId } = buildNativeOAuthProfileInput(input);
  validateInput(profileInput, profileId ? getModelCredentialProfile(profileId) || undefined : undefined, { allowIncompleteOAuth: true });
  const job = createOAuthLoginJob(providerId, profileInput, profileId);
  await Promise.race([job.ready, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  return sanitizeOAuthJob(job);
}

export async function startOAuthLoginJob(input: { profileId?: string; profile?: Partial<ModelCredentialProfileInput>; providerId?: string; name?: string }): Promise<OAuthLoginJobPublic> {
  if (!input.profile) {
    return startNativeOAuthConnection({ providerId: input.providerId || "", profileId: input.profileId, name: input.name });
  }

  const existing = input.profileId ? getModelCredentialProfile(input.profileId) : null;
  const profileInput = {
    ...(existing || {}),
    ...(input.profile || {}),
    id: input.profileId,
    authType: "oauth" as const,
    oauthProviderId: input.providerId || input.profile?.oauthProviderId || existing?.oauthProviderId,
    apiKey: undefined,
    oauthCredentials: undefined,
  } as ModelCredentialProfileInput & { id?: string };
  const providerId = validateOAuthProvider(profileInput.oauthProviderId);
  validateInput(profileInput, existing || undefined, { allowIncompleteOAuth: true });
  const job = createOAuthLoginJob(providerId, profileInput, input.profileId);
  await Promise.race([job.ready, new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
  return sanitizeOAuthJob(job);
}

export function getOAuthLoginJob(id: string): OAuthLoginJobPublic | null {
  const job = oauthJobs.get(id);
  return job ? sanitizeOAuthJob(job) : null;
}

export function cancelOAuthLoginJob(id: string): OAuthLoginJobPublic | null {
  const job = oauthJobs.get(id);
  if (!job) return null;
  if (job.status !== "completed") {
    job.status = "cancelled";
    job.abortController.abort();
    job.inputWaiter?.reject(new Error("OAuth login job was cancelled"));
  }
  job.updatedAt = now();
  return sanitizeOAuthJob(job);
}

export async function submitOAuthLoginJobInput(id: string, input: { code?: string }): Promise<OAuthLoginJobPublic | null> {
  const job = oauthJobs.get(id);
  if (!job) return null;
  if (job.status === "cancelled") throw new Error("OAuth login job was cancelled");
  if (job.status === "completed") return sanitizeOAuthJob(job);
  if (job.status === "failed") throw new Error(job.error || "OAuth login job failed");
  if (input.code === undefined || (!job.prompt.includes("blank") && !input.code.trim())) throw new Error("OAuth input is required");
  const waiter = job.inputWaiter;
  if (!waiter) throw new Error("OAuth login job is not waiting for input");
  job.inputWaiter = undefined;
  waiter.resolve(input.code);
  await Promise.race([job.loginPromise, new Promise<void>((resolve) => setTimeout(resolve, 30_000))]);
  return sanitizeOAuthJob(job);
}

export interface ModelDiscoveryResult {
  models: ModelDefinitionConfig[];
  partial: boolean;
  warnings: string[];
}

const DISCOVERY_SUPPORTED_PROTOCOLS: ModelProtocol[] = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
];

function classifyNetworkError(err: unknown): Error {
  const text = String((err as any)?.message || err || "network error");
  if (text.toLowerCase().includes("invalid url")) return new Error("invalid baseUrl");
  if ((err as any)?.name === "AbortError" || text.toLowerCase().includes("timeout")) return new Error("network timeout while fetching models");
  return new Error("network error while fetching models");
}

function buildModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = `${pathname}/models`.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(num) && num > 0) return num;
  }
  return undefined;
}

function explicitBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
}

function clonePlainObject<T extends Record<string, unknown>>(value: unknown): T | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { return undefined; }
}

function modelSdkMetadata(raw: any): Pick<ModelDefinitionConfig, "thinkingLevelMap" | "compat"> {
  return {
    ...(clonePlainObject(raw?.thinkingLevelMap) ? { thinkingLevelMap: clonePlainObject(raw.thinkingLevelMap) } : {}),
    ...(clonePlainObject(raw?.compat) ? { compat: clonePlainObject(raw.compat) } : {}),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function coerceDiscoveredModel(raw: any): ModelDefinitionConfig | null {
  const id = typeof raw?.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  const contextWindow = positiveNumber(raw?.contextWindow, raw?.context_window, raw?.context_length, raw?.max_context_length, raw?.max_context_tokens, raw?.max_model_len);
  const maxTokens = positiveNumber(raw?.maxTokens, raw?.max_tokens, raw?.max_output_tokens, raw?.max_completion_tokens);
  const reasoning = explicitBoolean(raw?.reasoning, raw?.supports_reasoning, raw?.capabilities?.reasoning);
  const hasEndpointMetadata = contextWindow !== undefined || maxTokens !== undefined || reasoning !== undefined;
  return {
    id,
    name: typeof raw?.name === "string" ? raw.name : undefined,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(Array.isArray(raw?.input) && raw.input.length ? { input: raw.input } : {}),
    ...modelSdkMetadata(raw),
    metadataSource: hasEndpointMetadata ? "endpoint" : "unknown",
  };
}

function normalizeRuntimeBaseUrl(profile: ModelCredentialProfile, rawBaseUrl: string): string {
  if (profile.protocol !== "anthropic-messages") return rawBaseUrl;
  try {
    const url = new URL(rawBaseUrl);
    const trimmed = url.pathname.replace(/\/+$/, "");
    if (trimmed.endsWith("/v1")) {
      url.pathname = (trimmed.length > 3 ? trimmed.slice(0, -3) : "") || "/";
      return url.toString();
    }
  } catch {
    return rawBaseUrl;
  }
  return rawBaseUrl;
}

function hasSameMetadata(a: ModelDiscoveredMetadata, b: ModelDiscoveredMetadata): boolean {
  const normalizeInputs = (items?: Array<"text" | "image">) => {
    const copy = items ? [...items] : undefined;
    return copy ? copy.sort() : undefined;
  };
  return (
    a.contextWindow === b.contextWindow
    && a.maxTokens === b.maxTokens
    && a.reasoning === b.reasoning
    && JSON.stringify(normalizeInputs(a.input)) === JSON.stringify(normalizeInputs(b.input))
    && sameJson(a.thinkingLevelMap, b.thinkingLevelMap)
    && sameJson(a.compat, b.compat)
  );
}

function applyConsistentMetadataFallback(matches: ModelDiscoveredMetadata[]): ModelDiscoveredMetadata | null {
  if (matches.length === 0) return null;
  const first = matches[0];
  if (
    first.contextWindow === undefined
    && first.maxTokens === undefined
    && first.reasoning === undefined
    && !first.input
    && !first.thinkingLevelMap
    && !first.compat
  ) {
    return null;
  }
  if (!matches.every((m) => hasSameMetadata(m, first))) return null;
  return first;
}

export function setPiCatalogModelsForTests(models: any[] | null): void {
  piCatalogModelsForTests = models;
}

class NoopCredentialStore implements CredentialStore {
  async read(): Promise<Credential | undefined> { return undefined; }
  async list(): Promise<readonly CredentialInfo[]> { return []; }
  async modify(_providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> { return fn(undefined); }
  async delete(): Promise<void> {}
}

// Credential-less registry used only for static catalog metadata (model list, provider display
// names, OAuth-provider ids) — not for real request auth. ModelRuntime.create() is async, but the
// many callers below (validateInput, sanitizeProfile, etc.) are synchronous; the cache is warmed
// once (lazily, or eagerly via ensurePiCatalogWarm() at server startup) and read synchronously
// afterward. Before the cache is warm, callers fall back to their pre-existing empty/default
// behavior (unchanged from before this migration).
let catalogRegistryPromise: Promise<ModelRegistry> | null = null;
let catalogRegistrySync: ModelRegistry | null = null;
let catalogRuntimeSync: ModelRuntime | null = null;

async function ensureCatalogRegistry(): Promise<ModelRegistry> {
  if (catalogRegistrySync) return catalogRegistrySync;
  if (!catalogRegistryPromise) {
    catalogRegistryPromise = ModelRuntime.create({ credentials: new NoopCredentialStore(), modelsPath: null, allowModelNetwork: false })
      .then((runtime) => {
        const registry = new ModelRegistry(runtime);
        catalogRuntimeSync = runtime;
        catalogRegistrySync = registry;
        return registry;
      })
      .catch((err) => {
        catalogRegistryPromise = null;
        throw err;
      });
  }
  return catalogRegistryPromise;
}

async function ensureCatalogRegistryRuntime(): Promise<ModelRuntime> {
  await ensureCatalogRegistry();
  if (!catalogRuntimeSync) throw new Error("pi model catalog is unavailable");
  return catalogRuntimeSync;
}

/** Pre-warm the credential-less catalog cache so the synchronous readers below have data
 * immediately. Call once at server startup; safe to call multiple times (memoized). */
export async function ensurePiCatalogWarm(): Promise<void> {
  try { await ensureCatalogRegistry(); } catch { /* leave cache cold; sync readers fall back gracefully */ }
}

async function loadPiCatalogModels(): Promise<any[]> {
  if (piCatalogModelsForTests) return piCatalogModelsForTests;
  try {
    const registry = await ensureCatalogRegistry();
    return typeof registry.getAll === "function" ? registry.getAll() : [];
  } catch {
    return [];
  }
}

function loadPiCatalogModelsSync(): any[] {
  if (piCatalogModelsForTests) return piCatalogModelsForTests;
  if (!catalogRegistrySync) return [];
  try {
    return typeof catalogRegistrySync.getAll === "function" ? catalogRegistrySync.getAll() : [];
  } catch {
    return [];
  }
}

function displayNameForProvider(providerSlug: string): string {
  if (!catalogRegistrySync) return providerSlug;
  try {
    return catalogRegistrySync.getProviderDisplayName(providerSlug) || providerSlug;
  } catch {
    return providerSlug;
  }
}

function oauthProviderIds(): Set<string> {
  if (!catalogRuntimeSync) return new Set(OAUTH_PROVIDERS as readonly string[]);
  try {
    return new Set(catalogRuntimeSync.getProviders().filter((p) => p.auth.oauth).map((p) => p.id));
  } catch {
    return new Set(OAUTH_PROVIDERS as readonly string[]);
  }
}

function modelsForBuiltinProvider(providerSlug: string, baseUrlOverride?: string): ModelDefinitionConfig[] {
  return loadPiCatalogModelsSync()
    .filter((m) => m.provider === providerSlug)
    .map((m) => ({
      id: String(m.id),
      name: typeof m.name === "string" ? m.name : undefined,
      contextWindow: positiveNumber(m.contextWindow) ?? 128000,
      maxTokens: positiveNumber(m.maxTokens, m.max_output_tokens),
      reasoning: explicitBoolean(m.reasoning),
      input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
      ...modelSdkMetadata(m),
      metadataSource: "pi_catalog" as const,
    }))
    .filter((m) => !!m.id);
}

function firstBuiltinModel(providerSlug: string): any | undefined {
  return loadPiCatalogModelsSync().find((m) => m.provider === providerSlug);
}

function protocolForBuiltinProvider(providerSlug: string): ModelProtocol {
  const api = firstBuiltinModel(providerSlug)?.api;
  return MODEL_PROTOCOLS.includes(api) ? api : "openai-responses";
}

function baseUrlForBuiltinProvider(providerSlug: string, override?: string): string {
  return override || firstBuiltinModel(providerSlug)?.baseUrl || "https://api.example.invalid";
}

export function listBuiltinModelProviders(): PublicModelProvider[] {
  const oauthIds = oauthProviderIds();
  const byProvider = new Map<string, any[]>();
  for (const model of loadPiCatalogModelsSync()) {
    if (!model?.provider) continue;
    if (!BUILTIN_API_KEY_PROVIDERS.has(model.provider) && !oauthIds.has(model.provider)) continue;
    const list = byProvider.get(model.provider) || [];
    list.push(model);
    byProvider.set(model.provider, list);
  }

  return Array.from(byProvider.entries())
    .map(([providerSlug, models]) => {
      const authModes: Array<"api_key" | "oauth"> = [];
      if (BUILTIN_API_KEY_PROVIDERS.has(providerSlug)) authModes.push("api_key");
      if (oauthIds.has(providerSlug)) authModes.push("oauth");
      const protocol = MODEL_PROTOCOLS.includes(models[0]?.api) ? models[0].api as ModelProtocol : undefined;
      return {
        providerSlug,
        displayName: displayNameForProvider(providerSlug),
        authModes,
        defaultAuthMode: (authModes.includes("api_key") ? "api_key" : "oauth") as "api_key" | "oauth",
        modelCount: models.length,
        sampleModels: models.slice(0, 5).map((m) => String(m.id)),
        protocol,
        logoKey: providerSlug,
      };
    })
    .filter((p) => p.authModes.length > 0 && p.modelCount > 0)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function getBuiltinProvider(providerSlug: string): PublicModelProvider | null {
  return listBuiltinModelProviders().find((p) => p.providerSlug === providerSlug) ?? null;
}

function normalizeUrlForCompare(value?: string): string {
  return (value || "").trim().replace(/\/+$/, "");
}

function isLegacyOfficialBuiltinProviderProfile(profile: ModelCredentialProfile): boolean {
  if (profile.profileKind) return false;
  if (profile.authType !== "api_key" && profile.authType !== "oauth") return false;
  if ((profile.requestProfile || "standard") !== "standard") return false;
  if (profile.authHeader || profile.headers) return false;
  if (!getBuiltinProvider(profile.providerSlug)) return false;
  if (profile.protocol !== protocolForBuiltinProvider(profile.providerSlug)) return false;
  const officialBaseUrl = baseUrlForBuiltinProvider(profile.providerSlug);
  return !profile.baseUrl || normalizeUrlForCompare(profile.baseUrl) === normalizeUrlForCompare(officialBaseUrl);
}

function isBuiltinProviderProfile(profile: ModelCredentialProfile): boolean {
  return profile.profileKind === "builtin_provider" || isLegacyOfficialBuiltinProviderProfile(profile);
}

function shouldUseSdkBuiltinCatalog(profile: ModelCredentialProfile): boolean {
  if (!isBuiltinProviderProfile(profile)) return false;
  if (hasModelCustomizations(profile)) return false;
  if ((profile.requestProfile || "standard") !== "standard") return false;
  if (profile.authHeader || profile.headers) return false;
  return normalizeUrlForCompare(profile.baseUrl) === normalizeUrlForCompare(baseUrlForBuiltinProvider(profile.providerSlug));
}

function refreshBuiltinProviderProfile(profile: ModelCredentialProfile): ModelCredentialProfile {
  if (!isBuiltinProviderProfile(profile)) return profile;
  const catalogModels = modelsForBuiltinProvider(profile.providerSlug, profile.baseUrl);
  if (catalogModels.length === 0) return profile;
  const modelCustomizations = sanitizeModelCustomizations(profile.modelCustomizations, catalogModels);
  const models = materializeBuiltinModels(catalogModels, modelCustomizations);
  if (models.length === 0) return profile;
  const next: ModelCredentialProfile = {
    ...profile,
    profileKind: "builtin_provider",
    protocol: protocolForBuiltinProvider(profile.providerSlug),
    baseUrl: baseUrlForBuiltinProvider(profile.providerSlug, profile.baseUrl),
    requestProfile: profile.requestProfile || "standard",
    models,
    modelCustomizations,
  };
  const changed = profile.profileKind !== next.profileKind
    || profile.protocol !== next.protocol
    || profile.baseUrl !== next.baseUrl
    || JSON.stringify(profile.models) !== JSON.stringify(next.models)
    || JSON.stringify(profile.modelCustomizations) !== JSON.stringify(next.modelCustomizations);
  return changed ? { ...next, updatedAt: now() } : profile;
}

function isDefaultTextOnlyInput(input: ModelDefinitionConfig["input"]): boolean {
  return Array.isArray(input) && input.length === 1 && input[0] === "text";
}

function migrateCustomEndpointVisionInput(profile: ModelCredentialProfile, catalog: any[]): ModelCredentialProfile {
  if ((profile.profileKind ?? "custom_endpoint") !== "custom_endpoint") return profile;
  let changed = false;
  const models = profile.models.map((model) => {
    if (!isDefaultTextOnlyInput(model.input)) return model;
    const fallbackInput = piCatalogFallbackMetadata(model.id, profile.providerSlug, catalog)?.input;
    if (!fallbackInput?.includes("image")) return model;
    changed = true;
    return {
      ...model,
      input: fallbackInput,
      metadataSource: model.metadataSource === "endpoint" ? "endpoint" as const : "pi_catalog" as const,
    };
  });
  return changed ? { ...profile, models, updatedAt: now() } : profile;
}

function refreshBuiltinProviderProfilesFromStore(options: { persist: boolean }): ModelCredentialProfile[] {
  const store = readStore();
  const catalog = loadPiCatalogModelsSync();
  let changed = false;
  const runVisionMigration = !store.migrations.includes(MIGRATION_CUSTOM_ENDPOINT_VISION_V1);
  const profiles = store.profiles.map((profile) => {
    const refreshed = refreshBuiltinProviderProfile(profile);
    const next = runVisionMigration ? migrateCustomEndpointVisionInput(refreshed, catalog) : refreshed;
    if (next !== profile) changed = true;
    return next;
  });
  const migrations = runVisionMigration ? [...store.migrations, MIGRATION_CUSTOM_ENDPOINT_VISION_V1] : store.migrations;
  if (runVisionMigration) changed = true;
  if (changed && options.persist) writeStore(profiles, migrations);
  return profiles;
}

export function refreshModelCredentialProfileModels(id: string): PublicModelCredentialProfile {
  const profiles = refreshBuiltinProviderProfilesFromStore({ persist: false });
  const profile = profiles.find((p) => p.id === id);
  if (!profile) throw new Error("Model credential profile not found");
  if (!isBuiltinProviderProfile(profile)) throw new Error("Only built-in provider profiles can refresh models from catalog");
  const refreshed = refreshBuiltinProviderProfile(profile);
  const next = profiles.map((p) => p.id === id ? refreshed : p);
  writeStore(next);
  return sanitizeProfile(refreshed);
}

function catalogMetadata(m: any): ModelDiscoveredMetadata {
  return {
    contextWindow: positiveNumber(m.contextWindow),
    maxTokens: positiveNumber(m.maxTokens, m.max_output_tokens),
    reasoning: explicitBoolean(m.reasoning, m.supports_reasoning),
    input: Array.isArray(m.input) ? m.input : undefined,
    ...modelSdkMetadata(m),
  };
}

function piCatalogFallbackMetadata(modelId: string, providerSlug: string, catalog: any[]): ModelDiscoveredMetadata | null {
  const exact = catalog.find((m) => m.provider === providerSlug && m.id === modelId);
  if (exact) return catalogMetadata(exact);

  const matches = catalog
    .filter((m) => m.id === modelId)
    .map(catalogMetadata);

  return applyConsistentMetadataFallback(matches);
}

function applyPiCatalogFallback(model: ModelDefinitionConfig, providerSlug: string, catalog: any[]): ModelDefinitionConfig {
  const fallback = piCatalogFallbackMetadata(model.id, providerSlug, catalog);

  if (!fallback) return model;

  const patched: ModelDefinitionConfig = {
    ...model,
    contextWindow: model.contextWindow ?? fallback.contextWindow,
    maxTokens: model.maxTokens ?? fallback.maxTokens,
    reasoning: model.reasoning ?? explicitBoolean(fallback.reasoning),
    ...(fallback.input && !model.input ? { input: fallback.input } : {}),
    ...(fallback.thinkingLevelMap && !model.thinkingLevelMap ? { thinkingLevelMap: fallback.thinkingLevelMap } : {}),
    ...(fallback.compat && !model.compat ? { compat: fallback.compat } : {}),
  };

  const added =
    patched.contextWindow !== model.contextWindow
    || patched.maxTokens !== model.maxTokens
    || patched.reasoning !== model.reasoning
    || !sameJson(patched.input, model.input)
    || !sameJson(patched.thinkingLevelMap, model.thinkingLevelMap)
    || !sameJson(patched.compat, model.compat);

  return added
    ? { ...patched, metadataSource: model.metadataSource === "endpoint" ? "endpoint" : "pi_catalog" }
    : model;
}

export async function discoverModelCredentialModels(input: Partial<ModelCredentialProfileInput> & { id?: string }): Promise<ModelDiscoveryResult> {
  const existing = input.id ? getModelCredentialProfile(input.id) : null;
  const protocol = input.protocol || existing?.protocol;
  if (!protocol || !DISCOVERY_SUPPORTED_PROTOCOLS.includes(protocol)) {
    throw new Error(`unsupported protocol for model discovery: ${protocol || "unknown"}`);
  }
  const authType = input.authType || existing?.authType || "api_key";
  const baseUrl = input.baseUrl || existing?.baseUrl;
  validateBaseUrl(baseUrl, authType);
  const apiKey = authType === "api_key" ? (input.apiKey || existing?.apiKey) : undefined;
  if (authType === "api_key" && !apiKey) throw new Error("auth error: apiKey is required to fetch models");
  if (authType === "oauth") throw new Error("unsupported auth type for model discovery: oauth");

  const headers: Record<string, string> = { Accept: "application/json", ...(existing?.headers || {}), ...(input.headers || {}) };
  if (authType === "api_key") headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(buildModelsUrl(baseUrl!), { method: "GET", headers, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw classifyNetworkError(err);
  }

  if (response.status === 401 || response.status === 403) throw new Error("auth error while fetching models");
  if (!response.ok) throw new Error(`network error while fetching models: HTTP ${response.status}`);

  let data: any;
  try { data = await response.json(); }
  catch { throw new Error("invalid models response: expected JSON"); }

  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : null;
  if (!items) throw new Error("invalid models response: expected data[] or models[]");
  const providerSlug = input.providerSlug || existing?.providerSlug || "";
  const catalog = await loadPiCatalogModels();
  const models = (items.map(coerceDiscoveredModel).filter(Boolean) as ModelDefinitionConfig[])
    .map((m) => applyPiCatalogFallback(m, providerSlug, catalog));
  const deduped = Array.from(new Map(models.map((m) => [m.id, m])).values()).sort((a, b) => a.id.localeCompare(b.id));
  return {
    models: deduped,
    partial: deduped.length !== items.length,
    warnings: deduped.length !== items.length ? ["Some returned models were skipped because they had no id."] : [],
  };
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
    throw new Error(`Credential profile ${profile.name} does not include model ${modelId}`);
  }
  return profile;
}

export function exportPiConfigForMember(args: {
  roomId: string;
  memberName: string;
  modelRef: string;
  credentialId?: string;
}): PiCredentialExport | null {
  const profile = resolveCredentialProfileForModel({ modelRef: args.modelRef, credentialId: args.credentialId });
  if (!profile) return null;

  const safeRoom = args.roomId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeMember = args.memberName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const agentDir = join(getBossmodePiRuntimeRoot(), safeRoom, safeMember);
  mkdirSync(agentDir, { recursive: true });

  const resolved = resolveRuntimeCredential(profile.id);
  const runtimeProfile = resolved.profile;
  writePrivateJson(join(agentDir, "models.json"), {
    providers: resolved.providerConfig ? { [runtimeProfile.providerSlug]: resolved.providerConfig } : {},
  });

  return { agentDir, extensionPaths: [], profile: sanitizeProfile(runtimeProfile) };
}
