import { getDatabase, sqliteBoolean, type Database } from "../data/database.js";
import { modelsForBuiltinProvider, validateThinkingLevelMap, modelSdkMetadata, oauthProviderIds, MODEL_PROTOCOLS, loadPiCatalogModelsSync, protocolForBuiltinProvider, baseUrlForBuiltinProvider, getBuiltinProvider, applyPiCatalogFallback, positiveNumber, explicitBoolean, type CatalogRefreshSource, type ModelDefinitionConfig, type ModelProtocol, refreshPiCatalogFromNetwork, getCatalogStatus, isCatalogRefreshDue, getCatalogAutoRefreshIntervalDays, piCatalogFallbackMetadata, ensurePiCatalogWarm, loadPiCatalogModels } from "./catalog.js";
import { randomUUID } from "node:crypto";
import { logger } from "../kernel/logger.js";
import { defined, optionalJson, parseObject } from "../kernel/json.js";
export type {ModelDefinitionConfig,ModelProtocol} from "./catalog.js";
export type ModelAuthType="api_key"|"oauth"|"none"|"ambient";
export type ModelCredentialProfileKind="builtin_provider"|"custom_endpoint"|"trusted_adapter";
export type ModelRequestProfile="standard"|"openai_codex_subscription";
export interface ModelCredentialProfile {id:string;profileKind?:ModelCredentialProfileKind;name:string;providerSlug:string;protocol:ModelProtocol;baseUrl?:string;authType:ModelAuthType;apiKey?:string;oauthProviderId?:string;oauthCredentials?:Record<string,unknown>;requestProfile:ModelRequestProfile;authHeader?:boolean;headers?:Record<string,string>;enabled:boolean;isDefault:boolean;models:ModelDefinitionConfig[];modelCustomizations?:{disabled?:string[];contextWindowOverride?:Record<string,number>;addedModels?:ModelDefinitionConfig[]};createdAt:number;updatedAt:number;}
export type ModelCredentialProfileInput=Omit<ModelCredentialProfile,"id"|"createdAt"|"updatedAt">;
export interface PublicModelCredentialProfile extends Omit<ModelCredentialProfile,"apiKey"|"oauthCredentials"> {hasSecret:boolean;modelRefs:string[];catalogModels?:ModelDefinitionConfig[];addedModels?:ModelDefinitionConfig[];}
export interface ConnectApiKeyRequest {providerSlug:string;apiKey:string;name?:string;baseUrlOverride?:string;requestProfile?:ModelRequestProfile;isDefault?:boolean;}
export interface OAuthDeviceCodeInfo {userCode:string;verificationUri:string;expiresInSeconds?:number;intervalSeconds?:number;}
export interface OAuthSelectPrompt {message:string;options:Array<{id:string;label:string}>;}
export interface AvailableModelOption extends Omit<ModelDefinitionConfig,"id"|"name"> {ref:string;provider:string;providerSlug:string;providerDisplayName?:string;modelId:string;displayName?:string;profileId:string;profileName:string;profileBaseUrl?:string;protocol:ModelProtocol;credentialStatus:"configured"|"missing"|"no_auth"|"ambient";images:boolean;}



export const DUMMY_API_KEY = "__bossmode_no_auth__";

const AUTH_TYPES: ModelAuthType[] = ["api_key", "oauth", "none", "ambient"];

const REQUEST_PROFILES: ModelRequestProfile[] = ["standard", "openai_codex_subscription"];

const PROFILE_KINDS: ModelCredentialProfileKind[] = ["builtin_provider", "custom_endpoint", "trusted_adapter"];

const MIGRATION_CUSTOM_ENDPOINT_VISION_V1 = "custom-endpoint-vision-v1";

const MIGRATION_CUSTOM_ENDPOINT_REASONING_DEFAULT_V1 = "custom-endpoint-reasoning-default-v1";

type ModelCredentialStore = { profiles: ModelCredentialProfile[]; migrations: string[] };

export type OAuthCredentials = { refresh: string; access: string; expires: number; [key: string]: unknown };

export type OAuthLoginCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onDeviceCode: (deviceCode: OAuthDeviceCodeInfo) => void;
  onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
};

export interface OAuthLoginAdapter {
  login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}

export function now(): number { return Date.now(); }


function writeStore(profiles: ModelCredentialProfile[], migrations?: string[]): void {
  replaceCredentialStore({ profiles, migrations: migrations ?? readCredentialStore().migrations }, getDatabase());
}

export function sanitizeProfile(profile: ModelCredentialProfile): PublicModelCredentialProfile {
  const { apiKey: _apiKey, oauthCredentials: _oauthCredentials, headers: _headers, ...rest } = profile;
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
  const thinkingLevelMap = validateThinkingLevelMap(model.thinkingLevelMap);
  const input = model.input?.length ? model.input : undefined;
  const { input: _input, thinkingLevelMap: _map, ...rest } = model;
  return {
    ...rest,
    id: model.id.trim(),
    name: model.name?.trim() || undefined,
    ...(input ? { input } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...modelSdkMetadata({ ...model, thinkingLevelMap }),
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

function materializeBuiltinModels(catalogModels: ModelDefinitionConfig[], customizations?: ModelCredentialProfile["modelCustomizations"]): ModelDefinitionConfig[] {
  return [...applyBuiltinModelCustomizations(catalogModels, customizations), ...(customizations?.addedModels || [])];
}

export function validateOAuthProvider(providerId: string | undefined): string {
  const value = providerId || "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error("Unsupported OAuth provider");
  if (!oauthProviderIds().has(value)) throw new Error("Unsupported OAuth provider");
  return value;
}

export function hasCompleteOAuthCredentials(value: unknown): value is OAuthCredentials {
  const c = value as Partial<OAuthCredentials> | undefined;
  return !!c && typeof c.access === "string" && c.access.length > 0 && typeof c.refresh === "string" && c.refresh.length > 0 && typeof c.expires === "number";
}

export function sanitizeOAuthCredentials(credentials: OAuthCredentials): OAuthCredentials {
  return { ...credentials, access: credentials.access, refresh: credentials.refresh, expires: credentials.expires };
}

export function isNewerOAuthCredential(candidate: OAuthCredentials, current: unknown): boolean {
  if (!hasCompleteOAuthCredentials(current)) return true;
  return candidate.expires > current.expires;
}





const profileModifications = new Map<string, Promise<void>>();

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

export function validateInput(input: ModelCredentialProfileInput, existing?: ModelCredentialProfile, options: { allowIncompleteOAuth?: boolean } = {}): ModelCredentialProfileInput & { models: ModelDefinitionConfig[]; profileKind: ModelCredentialProfileKind } {
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
    .map((m) => applyPiCatalogFallback(m, input.providerSlug.trim(), loadPiCatalogModelsSync()))
    .map(defaultCustomEndpointReasoning);
  if (models.length === 0) throw new Error("at least one model is required");
  validateUniqueModels(models);
  return { ...input, profileKind, name: input.name.trim(), providerSlug: input.providerSlug.trim(), requestProfile, models };
}

export function loadModelCredentialProfiles(): ModelCredentialProfile[] {
  return readCredentialStore().profiles;
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
  return getDatabase().transaction(() => {
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
      headers: valid.headers ?? existing?.headers,
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
  });
}

export function nextBuiltinProfileName(providerSlug: string, displayName: string): string {
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
  return getDatabase().transaction(() => {
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
  });
}

export function deleteModelCredentialProfile(id: string): boolean {
  return getDatabase().transaction(() => {
    const profiles = loadModelCredentialProfiles();
    const next = profiles.filter((p) => p.id !== id);
    if (next.length === profiles.length) return false;
    writeStore(next);
    return true;
  });
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

function defaultCustomEndpointReasoning(model: ModelDefinitionConfig): ModelDefinitionConfig {
  if (typeof model.reasoning === "boolean") return model;
  return { ...model, reasoning: true };
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
    reasoning: reasoning ?? true,
    ...(Array.isArray(raw?.input) && raw.input.length ? { input: raw.input } : {}),
    ...modelSdkMetadata(raw),
    metadataSource: hasEndpointMetadata ? "endpoint" : "unknown",
  };
}

export function normalizeRuntimeBaseUrl(profile: ModelCredentialProfile, rawBaseUrl: string): string {
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

const CATALOG_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let catalogRefreshInFlight: Promise<CatalogManualRefreshResult> | null = null;

let catalogSchedulerTimer: ReturnType<typeof setInterval> | null = null;

export interface CatalogManualRefreshResult {
  source: CatalogRefreshSource;
  error?: string;
  fetchedAt?: number | null;
  freshnessLabel: string;
  modelCount: number;
  triggered: boolean;
  reason: string;
}

export async function refreshBuiltinCatalog(reason: string): Promise<CatalogManualRefreshResult> {
  if (catalogRefreshInFlight) return catalogRefreshInFlight;
  catalogRefreshInFlight = (async () => {
    logger.info("catalog", "builtin catalog refresh start", { reason });
    const catalog = await refreshPiCatalogFromNetwork();
    try {
      refreshBuiltinProviderProfilesFromStore({ persist: true });
    } catch (err) {
      logger.warn("catalog", "rematerialize builtin profiles failed", { error: String(err) });
    }
    const status = getCatalogStatus();
    const result: CatalogManualRefreshResult = {
      source: catalog.source,
      error: catalog.error,
      fetchedAt: catalog.fetchedAt ?? status.fetchedAt,
      freshnessLabel: status.freshnessLabel,
      modelCount: status.modelCount,
      triggered: true,
      reason,
    };
    logger.info("catalog", "builtin catalog refresh done", {
      reason,
      source: result.source,
      modelCount: result.modelCount,
      error: result.error,
    });
    return result;
  })().finally(() => {
    catalogRefreshInFlight = null;
  });
  return catalogRefreshInFlight;
}

export function maybeRefreshCatalogInBackground(reason: string): void {
  if (!isCatalogRefreshDue()) return;
  void refreshBuiltinCatalog(reason).catch((err) => {
    logger.warn("catalog", "background refresh failed", { reason, error: String(err) });
  });
}

export function startCatalogAutoRefreshScheduler(): void {
  if (catalogSchedulerTimer) return;
  // Short delay so startup isn't competing with other warm paths.
  setTimeout(() => maybeRefreshCatalogInBackground("startup"), 8_000);
  catalogSchedulerTimer = setInterval(() => maybeRefreshCatalogInBackground("daily-check"), CATALOG_CHECK_INTERVAL_MS);
  // Don't keep the process alive solely for this timer.
  if (typeof catalogSchedulerTimer === "object" && catalogSchedulerTimer && "unref" in catalogSchedulerTimer) {
    try { (catalogSchedulerTimer as NodeJS.Timeout).unref(); } catch { /* ignore */ }
  }
  logger.info("catalog", "auto-refresh scheduler started", {
    intervalDays: getCatalogAutoRefreshIntervalDays(),
    checkEveryHours: 24,
  });
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
  return profile.profileKind === "builtin_provider";
}

export function shouldUseSdkBuiltinCatalog(profile: ModelCredentialProfile): boolean {
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

function migrateCustomEndpointReasoningDefault(profile: ModelCredentialProfile): ModelCredentialProfile {
  if ((profile.profileKind ?? "custom_endpoint") !== "custom_endpoint") return profile;
  let changed = false;
  const models = profile.models.map((model) => {
    if (typeof model.reasoning === "boolean") return model;
    changed = true;
    return { ...model, reasoning: true };
  });
  return changed ? { ...profile, models, updatedAt: now() } : profile;
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

export function normalizeLegacyCredentialImport(store: ModelCredentialStore, catalog: any[]): ModelCredentialStore {
  const vision = !store.migrations.includes(MIGRATION_CUSTOM_ENDPOINT_VISION_V1);
  const reasoning = !store.migrations.includes(MIGRATION_CUSTOM_ENDPOINT_REASONING_DEFAULT_V1);
  return {
    profiles: store.profiles.map(profile => {
      const legacy = profile.requestProfile as string;
      let next = legacy === "anthropic_claude_code_oauth" || legacy === "anthropic_proxy_claude_code"
        ? { ...profile, requestProfile: "standard" as const } : profile;
      if (isLegacyOfficialBuiltinProviderProfile(next)) next = { ...next, profileKind: "builtin_provider" };
      if (vision) next = migrateCustomEndpointVisionInput(next, catalog);
      if (reasoning) next = migrateCustomEndpointReasoningDefault(next);
      return next;
    }),
    migrations: Array.from(new Set([...store.migrations, MIGRATION_CUSTOM_ENDPOINT_VISION_V1, MIGRATION_CUSTOM_ENDPOINT_REASONING_DEFAULT_V1])),
  };
}

function refreshBuiltinProviderProfilesFromStore(options: { persist: boolean }): ModelCredentialProfile[] {
  return getDatabase().transaction(() => {
    const store = readCredentialStore();
    const profiles = store.profiles.map(refreshBuiltinProviderProfile);
    if (options.persist && profiles.some((p, i) => p !== store.profiles[i])) writeStore(profiles, store.migrations);
    return profiles;
  });
}

export async function discoverModelCredentialModels(input: Partial<ModelCredentialProfileInput> & { id?: string }): Promise<ModelDiscoveryResult> {
  const existing = input.id ? getModelCredentialProfile(input.id) : null;
  const profileKind = input.profileKind || existing?.profileKind;
  const providerSlug = input.providerSlug || existing?.providerSlug || "";

  // Built-in providers: serve CatalogStore directly — no live provider /models fetch.
  // (custom_endpoint still hits the endpoint below.)
  const treatAsBuiltin = profileKind === "builtin_provider"
    || (!profileKind && !!providerSlug && !!getBuiltinProvider(providerSlug) && !input.baseUrl);
  if (treatAsBuiltin && providerSlug) {
    await ensurePiCatalogWarm();
    const models = modelsForBuiltinProvider(providerSlug, input.baseUrl || existing?.baseUrl);
    return { models, partial: false, warnings: [] };
  }

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

export interface CredentialImport { profiles: ModelCredentialProfile[]; migrations: string[] }

function nextCredentialRevision(db: Database = getDatabase()): number {
    db.run("UPDATE credential_revision SET value=value+1 WHERE id=1");
    return db.get<{value:number}>("SELECT value FROM credential_revision WHERE id=1")!.value;
  }

export function credentialRevision(id: string, db: Database = getDatabase()): number | null { return db.get<{revision: number}>("SELECT revision FROM model_profiles WHERE id=?", id)?.revision ?? null; }

export function credentialSnapshot(id: string, db: Database = getDatabase()): { profile: ModelCredentialProfile | null; revision: number | null } {
    return db.transaction(() => ({
      profile: readCredentialStore(db).profiles.find(p => p.id === id) ?? null,
      revision: credentialRevision(id, db),
    }));
  }

export function readCredentialStore(db: Database = getDatabase()): CredentialImport {
    return { profiles: db.all<any>("SELECT * FROM model_profiles ORDER BY position").map(r => {
      const secret = db.get<any>("SELECT * FROM model_secrets WHERE profile_id=?", r.id);
      const headers = Object.fromEntries(db.all<any>("SELECT name,value FROM model_headers WHERE profile_id=?", r.id).map(h => [h.name,h.value]));
      const custom = db.all<any>("SELECT * FROM model_customizations WHERE profile_id=?", r.id);
      const addedModels = readProfileModels(r.id, "added", db);
      const disabled = custom.filter(c => c.disabled).map(c => c.model_id);
      const contextWindowOverride = Object.fromEntries(custom.filter(c => c.context_window !== null).map(c => [c.model_id,c.context_window]));
      return {
        id: r.id, name: r.name, providerSlug: r.provider_slug, protocol: r.protocol, authType: r.auth_type,
        requestProfile: r.request_profile, enabled: !!r.enabled, isDefault: !!r.is_default, createdAt: r.created_at, updatedAt: r.updated_at,
        ...defined({ profileKind: r.profile_kind, baseUrl: r.base_url, oauthProviderId: r.oauth_provider_id,
          authHeader: r.auth_header === null ? undefined : !!r.auth_header, apiKey: secret?.api_key,
          oauthCredentials: secret?.oauth_json ? parseObject(secret.oauth_json) : undefined }),
        ...(Object.keys(headers).length ? { headers } : {}), models: readProfileModels(r.id,"model", db),
        ...(custom.length || addedModels.length ? { modelCustomizations: { disabled, contextWindowOverride, addedModels } } : {}),
      } as ModelCredentialProfile;
    }), migrations: db.all<{id: string}>("SELECT id FROM credential_migrations ORDER BY id").map(r => r.id) };
  }

function readProfileModels(profileId: string, kind: string, db: Database = getDatabase()): ModelDefinitionConfig[] {
    return db.all<any>("SELECT * FROM model_definitions WHERE profile_id=? AND kind=? ORDER BY position", profileId, kind).map(r => ({
      id: r.id, ...defined({ name:r.name, contextWindow:r.context_window, maxTokens:r.max_tokens,
        reasoning:r.reasoning === null ? undefined : !!r.reasoning, metadataSource:r.metadata_source,
        input:r.input_text === null ? undefined : [...(r.input_text ? ["text"] : []), ...(r.input_image ? ["image"] : [])],
        thinkingLevelMap:r.thinking_json ? parseObject(r.thinking_json) : undefined, compat:r.compat_json ? parseObject(r.compat_json) : undefined }),
    } as ModelDefinitionConfig));
  }

function writeProfileModels(profileId: string, kind: string, models: ModelDefinitionConfig[], db: Database = getDatabase()): void {
    models.forEach((m, i) => db.run("INSERT INTO model_definitions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", profileId,kind,m.id,i,
      m.name ?? null,m.contextWindow ?? null,m.maxTokens ?? null,sqliteBoolean(m.reasoning),sqliteBoolean(m.input?.includes("text")),sqliteBoolean(m.input?.includes("image")),
      optionalJson(m.thinkingLevelMap),optionalJson(m.compat),m.metadataSource ?? null));
  }

export function importModelProfile(p: ModelCredentialProfile, position?: number, db: Database = getDatabase()): void {
    db.transaction(tx => {
      const previous = tx.get<any>("SELECT position,revision FROM model_profiles WHERE id=?",p.id);
      const ordinal = position ?? previous?.position ?? tx.get<{n:number}>("SELECT coalesce(max(position)+1,0) AS n FROM model_profiles")!.n;
      tx.run(`INSERT INTO model_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        position=excluded.position,profile_kind=excluded.profile_kind,name=excluded.name,provider_slug=excluded.provider_slug,
        protocol=excluded.protocol,base_url=excluded.base_url,auth_type=excluded.auth_type,oauth_provider_id=excluded.oauth_provider_id,
        request_profile=excluded.request_profile,auth_header=excluded.auth_header,enabled=excluded.enabled,is_default=excluded.is_default,
        created_at=excluded.created_at,updated_at=excluded.updated_at,revision=excluded.revision`,
        p.id,ordinal,p.profileKind ?? null,p.name,p.providerSlug,p.protocol,p.baseUrl ?? null,p.authType,p.oauthProviderId ?? null,p.requestProfile,
        sqliteBoolean(p.authHeader),Number(p.enabled),Number(p.isDefault),p.createdAt,p.updatedAt,nextCredentialRevision(db));
      tx.run("INSERT OR REPLACE INTO model_secrets VALUES (?,?,?)",p.id,p.apiKey ?? null,optionalJson(p.oauthCredentials));
      tx.run("DELETE FROM model_headers WHERE profile_id=?",p.id);
      for (const [name,value] of Object.entries(p.headers ?? {})) tx.run("INSERT INTO model_headers VALUES (?,?,?)",p.id,name,value);
      tx.run("DELETE FROM model_definitions WHERE profile_id=?",p.id);
      writeProfileModels(p.id,"model",p.models, db);
      writeProfileModels(p.id,"added",p.modelCustomizations?.addedModels ?? [], db);
      tx.run("DELETE FROM model_customizations WHERE profile_id=?",p.id);
      const disabled = new Set(p.modelCustomizations?.disabled ?? []);
      const overrides = p.modelCustomizations?.contextWindowOverride ?? {};
      for (const id of new Set([...disabled,...Object.keys(overrides)])) tx.run("INSERT INTO model_customizations VALUES (?,?,?,?)",p.id,id,Number(disabled.has(id)),overrides[id] ?? null);
    });
  }

export function replaceCredentialStore(store: CredentialImport, db: Database = getDatabase()): void {
    db.transaction(tx => {
      const previous = readCredentialStore(db).profiles;
      for (const p of previous) if (!store.profiles.some(n => n.id === p.id)) tx.run("DELETE FROM model_profiles WHERE id=?",p.id);
      store.profiles.forEach((p,i) => {
        const old = previous.find(v => v.id === p.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(p)) importModelProfile(p,i, db);
        else tx.run("UPDATE model_profiles SET position=? WHERE id=?",i,p.id);
      });
      tx.run("DELETE FROM credential_migrations");
      for (const id of store.migrations) tx.run("INSERT INTO credential_migrations VALUES (?)",id);
    });
  }

export function updateCredentialSecret(id: string, provider: string, revision: number, credential: {apiKey?: string; oauthCredentials?: Record<string, unknown>}, updatedAt: number, db: Database = getDatabase()): boolean {
    return db.transaction(tx => {
      const p = readCredentialStore(db).profiles.find(p => p.id === id);
      if (!p || !p.enabled || p.providerSlug !== provider || credentialRevision(id, db) !== revision) return false;
      if (credential.oauthCredentials && p.authType !== "oauth" || credential.apiKey && p.authType !== "api_key") return false;
      // Revision increments only; do not replace a whole profile from an old snapshot.
      tx.run("UPDATE model_secrets SET api_key=?,oauth_json=? WHERE profile_id=?",credential.apiKey ?? p.apiKey ?? null,optionalJson(credential.oauthCredentials ?? p.oauthCredentials),id);
      tx.run("UPDATE model_profiles SET revision=?,updated_at=? WHERE id=?",nextCredentialRevision(db),updatedAt,id);
      return true;
    });
  }

export function normalizeModelRef(modelRef: string): string { return modelRef.trim(); }

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

export function listAvailableModels(): AvailableModelOption[] {
  return loadModelCredentialProfiles()
    .filter((p) => p.enabled)
    .filter((p) => p.authType !== "oauth" || hasCompleteOAuthCredentials(p.oauthCredentials))
    .flatMap((profile) => profile.models.map((model) => modelOptionFromProfile(profile, model)));
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

export type ModelCredential = { type: "api_key"; key?: string; env?: Record<string, string> } | ({ type: "oauth" } & OAuthCredentials);

function credentialValue(profile: ModelCredentialProfile): ModelCredential | undefined {
  if (profile.authType === "api_key") return { type: "api_key", key: profile.apiKey };
  if (profile.authType === "oauth") {
    if (!hasCompleteOAuthCredentials(profile.oauthCredentials)) throw new Error(`OAuth credential is incomplete for provider ${profile.providerSlug}`);
    return { type: "oauth", ...profile.oauthCredentials };
  }
  if (profile.authType === "none") return { type: "api_key", key: DUMMY_API_KEY };
  return undefined;
}

export function readModelCredential(profileId: string, providerSlug: string): ModelCredential | undefined {
  const profile = getModelCredentialProfile(profileId);
  return profile?.enabled && profile.providerSlug === providerSlug ? credentialValue(profile) : undefined;
}

export async function modifyModelCredential(profileId: string, providerSlug: string, fn: (current: ModelCredential | undefined) => Promise<ModelCredential | undefined>): Promise<ModelCredential | undefined> {
    const previous = profileModifications.get(profileId);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    profileModifications.set(profileId, pending);
    await previous;
    try {
      const repo = getDatabase();
      const { profile, revision } = credentialSnapshot(profileId, repo);
      const current = profile?.enabled && profile.providerSlug === providerSlug ? credentialValue(profile) as ModelCredential | undefined : undefined;
      const next = await fn(current);
      if (revision === null) return readModelCredential(profileId, providerSlug);
      if (next?.type === "oauth") {
        const { type: _type, ...oauth } = next as { type: "oauth" } & OAuthCredentials;
        if (hasCompleteOAuthCredentials(oauth)) {
          if (!isNewerOAuthCredential(oauth, profile?.oauthCredentials)) return readModelCredential(profileId, providerSlug);
          if (!updateCredentialSecret(profileId, providerSlug, revision, { oauthCredentials: sanitizeOAuthCredentials(oauth) }, now(), repo)) return readModelCredential(profileId, providerSlug);
        }
      } else if (next?.type === "api_key" && typeof next.key === "string" && next.key.length > 0) {
        if (!updateCredentialSecret(profileId, providerSlug, revision, { apiKey: next.key }, now(), repo)) return readModelCredential(profileId, providerSlug);
      }
      // SDK contract: undefined from fn leaves the entry unchanged.
      return next ?? current;
    } finally {
      if (profileModifications.get(profileId) === pending) profileModifications.delete(profileId);
      release();
    }
  }
