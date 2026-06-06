import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AuthStorage, FileAuthStorageBackend, ModelRegistry, type AuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { getBossmodeDir, ensureBossmodeDir } from "../shared/config.js";
import type {
  ModelCredentialProfile,
  ModelCredentialProfileInput,
  PublicModelCredentialProfile,
  ModelOption,
  ModelProtocol,
  ModelAuthType,
  ModelRequestProfile,
  ModelDefinitionConfig,
  AvailableModelOption,
} from "../shared/types.js";

const STORE_FILE = "model-credentials.json";
const API_KEY_PLACEHOLDER = "__bossmode_managed_key__";
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
const REQUEST_PROFILES: ModelRequestProfile[] = ["standard", "anthropic_claude_code_oauth", "anthropic_proxy_claude_code", "openai_codex_subscription"];
const OAUTH_PROVIDERS = ["anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"] as const;

type OAuthJobStatus = "awaiting_input" | "completed" | "failed" | "cancelled";

export interface OAuthLoginJobPublic {
  id: string;
  status: OAuthJobStatus;
  providerId: string;
  authUrl?: string;
  userCode?: string;
  prompt: string;
  error?: string;
  profileId?: string;
  createdAt: number;
  updatedAt: number;
}

type OAuthCredentials = { refresh: string; access: string; expires: number; [key: string]: unknown };
type OAuthInputWaiter = { resolve: (value: string) => void; reject: (error: Error) => void };
type OAuthLoginCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  onSelect?: (prompt: { message: string; options: Array<{ id: string; label: string }> }) => Promise<string | undefined>;
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

export function getBossmodePiRegistryDir(): string {
  return join(getBossmodeDir(), "pi-agent", "model-registry");
}

function writePrivateJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function readStore(): { profiles: ModelCredentialProfile[] } {
  const path = storePath();
  if (!existsSync(path)) return { profiles: [] };
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { profiles?: ModelCredentialProfile[] };
  return { profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [] };
}

function writeStore(profiles: ModelCredentialProfile[]): void {
  ensureBossmodeDir();
  writePrivateJson(storePath(), { profiles });
}

function sanitizeProfile(profile: ModelCredentialProfile): PublicModelCredentialProfile {
  const { apiKey: _apiKey, oauthCredentials: _oauthCredentials, ...rest } = profile;
  return {
    ...rest,
    hasSecret: !!profile.apiKey || !!profile.oauthCredentials,
    modelRefs: profile.models.map((m) => `${profile.providerSlug}/${m.id}`),
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

function validateModel(model: ModelDefinitionConfig): ModelDefinitionConfig {
  if (!model.id?.trim()) throw new Error("model id is required");
  if (model.contextWindow !== undefined && (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0)) throw new Error("contextWindow must be greater than 0");
  if (model.maxTokens !== undefined && (!Number.isFinite(model.maxTokens) || model.maxTokens <= 0)) throw new Error("maxTokens must be greater than 0");
  const input = model.input?.length ? model.input : ["text" as const];
  return { ...model, id: model.id.trim(), name: model.name?.trim() || undefined, input, metadataSource: model.metadataSource || (model.contextWindow || model.maxTokens || model.reasoning !== undefined ? "endpoint" : "unknown") };
}

function validateOAuthProvider(providerId: string | undefined): string {
  const value = providerId || "";
  if (!(OAUTH_PROVIDERS as readonly string[]).includes(value)) throw new Error("Unsupported OAuth provider");
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

function parseAuthJson(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try { return JSON.parse(content) as Record<string, unknown>; } catch { return {}; }
}

function overlayProfileOAuthCredential(current: string | undefined, profileId: string, providerSlug: string): string {
  const data = parseAuthJson(current);
  const profile = getModelCredentialProfile(profileId);
  if (profile?.authType !== "oauth" || profile.providerSlug !== providerSlug || !hasCompleteOAuthCredentials(profile.oauthCredentials)) {
    return JSON.stringify(data, null, 2);
  }

  const fileCredential = data[providerSlug];
  if (fileCredential && typeof fileCredential === "object" && (fileCredential as any).type === "oauth") {
    const { type: _type, ...fileOAuth } = fileCredential as { type: "oauth" } & OAuthCredentials;
    if (hasCompleteOAuthCredentials(fileOAuth) && isNewerOAuthCredential(fileOAuth, profile.oauthCredentials)) {
      persistOAuthCredentialsForProfile(profileId, providerSlug, fileOAuth);
      data[providerSlug] = { type: "oauth", ...fileOAuth };
      return JSON.stringify(data, null, 2);
    }
  }

  data[providerSlug] = { type: "oauth", ...profile.oauthCredentials };
  return JSON.stringify(data, null, 2);
}

function syncOAuthCredentialFromAuthData(profileId: string, providerSlug: string, data: Record<string, unknown>): void {
  const credential = data[providerSlug];
  if (credential && typeof credential === "object" && (credential as any).type === "oauth") {
    const { type: _type, ...oauth } = credential as { type: "oauth" } & OAuthCredentials;
    if (hasCompleteOAuthCredentials(oauth)) persistOAuthCredentialsForProfile(profileId, providerSlug, oauth);
  }
}

class BossmodeOAuthSyncAuthStorageBackend implements AuthStorageBackend {
  private readonly fileBackend: FileAuthStorageBackend;

  constructor(authPath: string, private readonly profileId: string, private readonly providerSlug: string) {
    this.fileBackend = new FileAuthStorageBackend(authPath);
  }

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    return this.fileBackend.withLock((current) => {
      const overlaid = overlayProfileOAuthCredential(current, this.profileId, this.providerSlug);
      const result = fn(overlaid);
      if (result.next) syncOAuthCredentialFromAuthData(this.profileId, this.providerSlug, parseAuthJson(result.next));
      return result;
    });
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    return this.fileBackend.withLockAsync(async (current) => {
      const overlaid = overlayProfileOAuthCredential(current, this.profileId, this.providerSlug);
      const result = await fn(overlaid);
      if (result.next) syncOAuthCredentialFromAuthData(this.profileId, this.providerSlug, parseAuthJson(result.next));
      return result;
    });
  }
}

export function createSyncedAuthStorage(authPath: string, profile: Pick<ModelCredentialProfile, "id" | "providerSlug" | "authType">): AuthStorage {
  if (profile.authType === "oauth") {
    return AuthStorage.fromStorage(new BossmodeOAuthSyncAuthStorageBackend(authPath, profile.id, profile.providerSlug));
  }
  return AuthStorage.create(authPath);
}

function sanitizeOAuthJob(job: OAuthLoginJob): OAuthLoginJobPublic {
  const { profileInput: _profileInput, ...publicJob } = job;
  return publicJob;
}

function validateInput(input: ModelCredentialProfileInput, existing?: ModelCredentialProfile, options: { allowIncompleteOAuth?: boolean } = {}): ModelCredentialProfileInput & { models: ModelDefinitionConfig[] } {
  if (!input.name?.trim()) throw new Error("name is required");
  validateSlug(input.providerSlug || "");
  if (!MODEL_PROTOCOLS.includes(input.protocol)) throw new Error("Unsupported protocol");
  if (!AUTH_TYPES.includes(input.authType)) throw new Error("Unsupported auth type");
  const requestProfile = input.requestProfile || "standard";
  if (!REQUEST_PROFILES.includes(requestProfile)) throw new Error("Unsupported request profile");
  if ((requestProfile === "anthropic_claude_code_oauth" || requestProfile === "anthropic_proxy_claude_code") && input.protocol !== "anthropic-messages") {
    throw new Error("Anthropic Claude Code compatibility requires anthropic-messages protocol");
  }
  validateBaseUrl(input.baseUrl, input.authType);
  if (input.authType === "api_key" && !input.apiKey && !existing?.apiKey) throw new Error("apiKey is required");
  if (input.authType === "oauth") {
    validateOAuthProvider(input.oauthProviderId);
    const credentials = input.oauthCredentials ?? existing?.oauthCredentials;
    if (!options.allowIncompleteOAuth && !hasCompleteOAuthCredentials(credentials)) throw new Error("OAuth credential is incomplete; complete login before saving");
  }
  const models = (input.models || []).map(validateModel);
  if (models.length === 0) throw new Error("at least one model is required");
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
  return { ...input, name: input.name.trim(), providerSlug: input.providerSlug.trim(), requestProfile, models };
}

export function loadModelCredentialProfiles(): ModelCredentialProfile[] {
  return readStore().profiles;
}

export function listPublicModelCredentialProfiles(): PublicModelCredentialProfile[] {
  return loadModelCredentialProfiles().map(sanitizeProfile);
}

export function getModelCredentialProfile(id: string): ModelCredentialProfile | null {
  return loadModelCredentialProfiles().find((p) => p.id === id) ?? null;
}

export function saveModelCredentialProfile(input: ModelCredentialProfileInput & { id?: string }): PublicModelCredentialProfile {
  const profiles = loadModelCredentialProfiles();
  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined;
  const valid = validateInput(input, existing);
  const duplicate = profiles.find((p) => p.providerSlug === valid.providerSlug && p.id !== input.id);
  if (duplicate) throw new Error(`Provider slug already exists: ${valid.providerSlug}`);
  const ts = now();
  const profile: ModelCredentialProfile = {
    id: input.id || randomUUID().slice(0, 8),
    name: valid.name,
    providerSlug: valid.providerSlug,
    protocol: valid.protocol,
    baseUrl: valid.baseUrl,
    authType: valid.authType,
    apiKey: valid.authType === "api_key" ? (valid.apiKey ?? existing?.apiKey) : undefined,
    oauthProviderId: valid.authType === "oauth" ? valid.oauthProviderId : undefined,
    oauthCredentials: valid.authType === "oauth" ? (valid.oauthCredentials ?? existing?.oauthCredentials) : undefined,
    requestProfile: valid.requestProfile,
    authHeader: valid.authHeader,
    headers: valid.headers,
    enabled: valid.enabled ?? existing?.enabled ?? true,
    isDefault: valid.isDefault ?? existing?.isDefault ?? false,
    models: valid.models,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  const next = existing ? profiles.map((p) => p.id === existing.id ? profile : p) : [...profiles, profile];
  writeStore(next);
  return sanitizeProfile(profile);
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
    const auth = AuthStorage.inMemory({});
    const providers = auth.getOAuthProviders().map((p: any) => p.id);
    if (!providers.includes(providerId)) throw new Error(`OAuth provider ${providerId} is not supported by installed pi-ai (${providers.join(", ") || "none"})`);
    await auth.login(providerId, callbacks);
    const credential = auth.get(providerId);
    if (credential?.type !== "oauth" || !hasCompleteOAuthCredentials(credential)) throw new Error(`OAuth provider ${providerId} did not return complete credentials`);
    const { type: _type, ...credentials } = credential;
    return credentials as OAuthCredentials;
  }
}

function getOAuthLoginAdapter(): OAuthLoginAdapter {
  if (!oauthLoginAdapter) oauthLoginAdapter = new PiAiOAuthLoginAdapter();
  return oauthLoginAdapter;
}

export function setOAuthLoginAdapterForTests(adapter: OAuthLoginAdapter | null): void {
  oauthLoginAdapter = adapter;
}

function startOAuthLogin(job: OAuthLoginJob): void {
  job.loginPromise = getOAuthLoginAdapter().login(job.providerId, {
    signal: job.abortController.signal,
    onAuth: (info) => {
      job.authUrl = info.url;
      job.prompt = info.instructions || "Complete login in the opened provider page, then paste the returned code if requested.";
      job.updatedAt = now();
      job.resolveReady();
    },
    onPrompt: async (prompt) => {
      job.prompt = prompt.message;
      job.updatedAt = now();
      job.resolveReady();
      if (prompt.allowEmpty) return waitForOAuthInput(job).catch((err) => { throw err; });
      return waitForOAuthInput(job);
    },
    onManualCodeInput: async () => {
      job.prompt = "Paste the authorization code or full redirect URL.";
      job.updatedAt = now();
      job.resolveReady();
      return waitForOAuthInput(job);
    },
    onSelect: async (prompt) => {
      job.prompt = `${prompt.message} (${prompt.options.map((o) => o.label).join(", ")})`;
      job.updatedAt = now();
      job.resolveReady();
      return prompt.options[0]?.id;
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
    job.error = err.message || String(err);
    job.prompt = "OAuth login failed. Retry from Start login.";
    job.updatedAt = now();
    job.resolveReady();
  });
}

export async function startOAuthLoginJob(input: { profileId?: string; profile?: Partial<ModelCredentialProfileInput>; providerId?: string }): Promise<OAuthLoginJobPublic> {
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
  const nowTs = now();
  const id = randomUUID().slice(0, 8);
  const ready = createDeferred();
  const job: OAuthLoginJob = {
    id,
    status: "awaiting_input",
    providerId,
    prompt: "Starting provider OAuth login...",
    profileId: input.profileId,
    createdAt: nowTs,
    updatedAt: nowTs,
    profileInput,
    abortController: new AbortController(),
    ready: ready.promise,
    resolveReady: ready.resolve,
    loginPromise: Promise.resolve(),
  };
  oauthJobs.set(id, job);
  startOAuthLogin(job);
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
    ...(Array.isArray(raw?.input) && raw.input.length ? { input: raw.input } : { input: ["text"] }),
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
  ) {
    return null;
  }
  if (!matches.every((m) => hasSameMetadata(m, first))) return null;
  return first;
}

export function setPiCatalogModelsForTests(models: any[] | null): void {
  piCatalogModelsForTests = models;
}

async function loadPiCatalogModels(): Promise<any[]> {
  if (piCatalogModelsForTests) return piCatalogModelsForTests;
  try {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory({}));
    return typeof registry.getAll === "function" ? registry.getAll() : [];
  } catch {
    return [];
  }
}

function applyPiCatalogFallback(model: ModelDefinitionConfig, providerSlug: string, catalog: any[]): ModelDefinitionConfig {
  if (model.contextWindow !== undefined && model.maxTokens !== undefined && model.reasoning !== undefined) return model;

  const exact = catalog.find((m) => m.provider === providerSlug && m.id === model.id);
  const fallback = ((): { contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: Array<"text" | "image"> } | null => {
    if (exact) {
      return {
        contextWindow: positiveNumber(exact.contextWindow),
        maxTokens: positiveNumber(exact.maxTokens, exact.max_output_tokens),
        reasoning: explicitBoolean(exact.reasoning, exact.supports_reasoning),
        input: Array.isArray(exact.input) ? exact.input : undefined,
      };
    }

    const matches = catalog
      .filter((m) => m.id === model.id)
      .map((m) => ({
        contextWindow: positiveNumber(m.contextWindow),
        maxTokens: positiveNumber(m.maxTokens, m.max_output_tokens),
        reasoning: explicitBoolean(m.reasoning, m.supports_reasoning),
        input: Array.isArray(m.input) ? m.input : undefined,
      }));

    return applyConsistentMetadataFallback(matches);
  })();

  if (!fallback) return model;

  const patched: ModelDefinitionConfig = {
    ...model,
    contextWindow: model.contextWindow ?? fallback.contextWindow,
    maxTokens: model.maxTokens ?? fallback.maxTokens,
    reasoning: model.reasoning ?? explicitBoolean(fallback.reasoning),
    ...(fallback.input ? { input: fallback.input } : {}),
  };

  const added =
    patched.contextWindow !== model.contextWindow
    || patched.maxTokens !== model.maxTokens
    || patched.reasoning !== model.reasoning
    || (patched.input && JSON.stringify(patched.input) !== JSON.stringify(model.input));

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

function parseProviderFromModelRef(modelRef: string): string {
  const ref = normalizeModelRef(modelRef);
  const idx = ref.indexOf("/");
  return idx > 0 ? ref.slice(0, idx) : "anthropic";
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

export function writePiConfigForProfiles(profiles: ModelCredentialProfile[], targetDir: string): { extensionPaths: string[] } {
  mkdirSync(targetDir, { recursive: true });
  const enabledProfiles = profiles.filter((p) => p.enabled);
  const providers: Record<string, unknown> = {};
  const authData: Record<string, unknown> = {};
  const extensionPaths: string[] = [];
  for (const profile of enabledProfiles) {
    providers[profile.providerSlug] = piProviderConfig(profile);
    const auth = authEntry(profile);
    if (auth) authData[profile.providerSlug] = auth;
    if (requiresInternalExtension(profile)) {
      const extDir = join(targetDir, "extensions");
      mkdirSync(extDir, { recursive: true });
      const extPath = join(extDir, `${profile.providerSlug}.ts`);
      writeFileSync(extPath, extensionSource(profile), "utf-8");
      extensionPaths.push(extPath);
    }
  }
  writePrivateJson(join(targetDir, "models.json"), { providers });
  writePrivateJson(join(targetDir, "auth.json"), authData);
  return { extensionPaths };
}

export function createBossmodeModelRegistry(): { authStorage: AuthStorage; modelRegistry: ModelRegistry; registryDir: string } {
  const registryDir = getBossmodePiRegistryDir();
  writePiConfigForProfiles(loadModelCredentialProfiles(), registryDir);
  const authStorage = AuthStorage.create(join(registryDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(registryDir, "models.json"));
  return { authStorage, modelRegistry, registryDir };
}

export function listAvailableModels(): AvailableModelOption[] {
  const profiles = loadModelCredentialProfiles().filter((p) => p.enabled);
  if (profiles.length === 0) return [];
  const { modelRegistry } = createBossmodeModelRegistry();
  const profileByProvider = new Map(profiles.map((p) => [p.providerSlug, p]));
  return modelRegistry.getAvailable()
    .map((model: any) => {
      const profile = profileByProvider.get(model.provider);
      return profile ? modelOptionFromProfile(profile, model) : null;
    })
    .filter(Boolean) as AvailableModelOption[];
}

function piProviderConfig(profile: ModelCredentialProfile): Record<string, unknown> {
  const normalizedBaseUrl = normalizeRuntimeBaseUrl(profile, profile.baseUrl || "");
  return {
    baseUrl: normalizedBaseUrl,
    api: apiForProfile(profile),
    apiKey: profile.authType === "none" ? DUMMY_API_KEY : API_KEY_PLACEHOLDER,
    ...(profile.authHeader ? { authHeader: true } : {}),
    ...(profile.headers ? { headers: profile.headers } : {}),
    models: profile.models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      contextWindow: m.contextWindow ?? 128000,
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      input: m.input ?? ["text"],
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

function requiresInternalExtension(profile: ModelCredentialProfile): boolean {
  return profile.requestProfile === "anthropic_claude_code_oauth" || profile.requestProfile === "anthropic_proxy_claude_code";
}

function apiForProfile(profile: ModelCredentialProfile): string {
  if (profile.requestProfile === "anthropic_claude_code_oauth") return `${profile.providerSlug}-anthropic-claude-code-oauth`;
  if (profile.requestProfile === "anthropic_proxy_claude_code") return "anthropic-proxy-claude-code";
  return profile.protocol;
}

function extensionSource(profile: ModelCredentialProfile): string {
  const normalizedBaseUrl = normalizeRuntimeBaseUrl(profile, profile.baseUrl || "");
  if (profile.requestProfile === "anthropic_proxy_claude_code") return anthropicProxyClaudeCodeExtensionSource(profile, normalizedBaseUrl);
  return `import { streamSimpleAnthropic } from "@earendil-works/pi-ai";\n\nexport default function (pi) {\n  pi.registerProvider(${JSON.stringify(profile.providerSlug)}, {\n    baseUrl: ${JSON.stringify(normalizedBaseUrl)},\n    api: ${JSON.stringify(apiForProfile(profile))},\n    apiKey: ${JSON.stringify(API_KEY_PLACEHOLDER)},\n    models: ${JSON.stringify(profile.models)},\n    streamSimple(model, context, options) {\n      const proxyKey = options?.apiKey || "";\n      return streamSimpleAnthropic(\n        { ...model, api: "anthropic-messages", provider: ${JSON.stringify(profile.providerSlug)}, baseUrl: ${JSON.stringify(normalizedBaseUrl)} },\n        context,\n        {\n          ...options,\n          apiKey: "sk-ant-oat-" + proxyKey,\n          headers: { ...(options?.headers || {}), Authorization: "Bearer " + proxyKey },\n        },\n      );\n    },\n  });\n}\n`;
}

function anthropicProxyClaudeCodeExtensionSource(profile: ModelCredentialProfile, _normalizedBaseUrl: string): string {
  return `import { streamSimpleAnthropic } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PROVIDER = ${JSON.stringify(profile.providerSlug)};
const PROVIDER_API = "anthropic-proxy-claude-code";
const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.122 (external, sdk-cli)";
const CLAUDE_CODE_BETA = [
  "claude-code-20250219",
  "context-1m-2025-08-07",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "advisor-tool-2026-03-01",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
].join(",");
const CLAUDE_CODE_BILLING_HEADER =
  "x-anthropic-billing-header: cc_version=2.1.122.d65; cc_entrypoint=sdk-cli; cch=6b420;";
const DEVICE_ID_PATH = join(homedir(), ".pi", "agent", "anthropic-proxy-device-id");

let fallbackSessionId;
let cachedDeviceId;

function toClaudeCodeOAuthKey(apiKey) {
  return apiKey.startsWith("sk-ant-oat-") ? apiKey : "sk-ant-oat-" + apiKey;
}

function getSessionId(options) {
  fallbackSessionId ||= randomUUID();
  return options?.sessionId || fallbackSessionId;
}

function findClaudeDeviceId() {
  const roots = [join(homedir(), ".claude", "telemetry"), join(homedir(), ".claude", "statsig")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root).slice(-200)) {
      const path = join(root, file);
      try {
        if (!statSync(path).isFile()) continue;
        const text = readFileSync(path, "utf8");
        const match = text.match(/"(?:device_id|userID)"\\s*:\\s*"([a-f0-9]{64})"/i);
        if (match) return match[1].toLowerCase();
      } catch {
        // Ignore unreadable telemetry files.
      }
    }
  }
  return undefined;
}

function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const claudeDeviceId = findClaudeDeviceId();
    if (claudeDeviceId) {
      cachedDeviceId = claudeDeviceId;
      mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
      writeFileSync(DEVICE_ID_PATH, cachedDeviceId + "\\n", { mode: 0o600 });
      return cachedDeviceId;
    }
    if (existsSync(DEVICE_ID_PATH)) {
      const value = readFileSync(DEVICE_ID_PATH, "utf8").trim();
      if (/^[a-f0-9]{64}$/i.test(value)) {
        cachedDeviceId = value.toLowerCase();
        return cachedDeviceId;
      }
    }
    cachedDeviceId = randomBytes(32).toString("hex");
    mkdirSync(dirname(DEVICE_ID_PATH), { recursive: true });
    writeFileSync(DEVICE_ID_PATH, cachedDeviceId + "\\n", { mode: 0o600 });
    return cachedDeviceId;
  } catch {
    cachedDeviceId ||= randomBytes(32).toString("hex");
    return cachedDeviceId;
  }
}

function patchClaudeCodePayload(payload, sessionId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

  const body = payload;
  body.metadata = {
    ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
    user_id: JSON.stringify({
      device_id: getDeviceId(),
      account_uuid: "",
      session_id: sessionId,
    }),
  };

  const billingBlock = { type: "text", text: CLAUDE_CODE_BILLING_HEADER };
  const existingSystem = Array.isArray(body.system)
    ? body.system
    : typeof body.system === "string"
      ? [{ type: "text", text: body.system }]
      : [];
  const systemText = existingSystem
    .filter(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        !block.text.startsWith("x-anthropic-billing-header:"),
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\\n\\n");

  body.system = [billingBlock];
  if (systemText && Array.isArray(body.messages) && body.messages.length > 0) {
    const firstUser = body.messages.find((message) => message?.role === "user") ?? body.messages[0];
    const reminderText = "<pi-system-prompt>\\n" + systemText + "\\n</pi-system-prompt>";
    if (Array.isArray(firstUser.content)) {
      const alreadyInserted = firstUser.content.some(
        (block) => block?.type === "text" && typeof block.text === "string" && block.text.startsWith("<pi-system-prompt>"),
      );
      if (!alreadyInserted) firstUser.content.unshift({ type: "text", text: reminderText });
    } else if (typeof firstUser.content === "string" && !firstUser.content.startsWith("<pi-system-prompt>")) {
      firstUser.content = reminderText + "\\n\\n" + firstUser.content;
    }
  }

  return body;
}

function streamClaudeCodeAnthropicProxy(model, context, options) {
  const apiKey = options?.apiKey;
  if (!apiKey) {
    throw new Error("No API key for provider: " + model.provider);
  }

  const sessionId = getSessionId(options);
  const { Authorization: _authorization, authorization: _authorizationLower, ...headers } = options?.headers ?? {};
  const originalOnPayload = options?.onPayload;

  return streamSimpleAnthropic(
    {
      ...model,
      api: "anthropic-messages",
      provider: PROVIDER,
    },
    context,
    {
      ...options,
      apiKey: toClaudeCodeOAuthKey(apiKey),
      headers: {
        ...headers,
        Authorization: "Bearer " + apiKey,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "X-Claude-Code-Session-Id": sessionId,
        "anthropic-beta": CLAUDE_CODE_BETA,
      },
      onPayload: async (payload, patchedModel) => {
        const patched = patchClaudeCodePayload(payload, sessionId);
        const nextPayload = await originalOnPayload?.(patched, patchedModel);
        return patchClaudeCodePayload(nextPayload ?? patched, sessionId);
      },
    },
  );
}

export default function (pi) {
  pi.registerProvider(PROVIDER, {
    api: PROVIDER_API,
    streamSimple: streamClaudeCodeAnthropicProxy,
  });
}
`;
}

export interface PiCredentialExport {
  agentDir: string;
  extensionPaths: string[];
  profile?: PublicModelCredentialProfile;
}

export function exportPiConfigForMember(args: {
  roomId: string;
  memberName: string;
  modelRef: string;
  credentialId?: string;
}): PiCredentialExport | null {
  const profiles = loadModelCredentialProfiles().filter((p) => p.enabled);
  if (profiles.length === 0) return null;
  const provider = parseProviderFromModelRef(args.modelRef);
  const profile = args.credentialId
    ? profiles.find((p) => p.id === args.credentialId)
    : profiles.find((p) => p.providerSlug === provider && p.isDefault) ?? profiles.find((p) => p.providerSlug === provider);
  if (!profile) return null;
  if (profile.providerSlug !== provider) {
    throw new Error(`Credential provider ${profile.providerSlug} does not match model provider ${provider}`);
  }

  const safeRoom = args.roomId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeMember = args.memberName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const agentDir = join(getBossmodePiRuntimeRoot(), safeRoom, safeMember);
  mkdirSync(agentDir, { recursive: true });

  const authPath = join(agentDir, "auth.json");
  let runtimeProfile = profile;
  if (profile.authType === "oauth" && existsSync(authPath)) {
    const existingAuth = parseAuthJson(readFileSync(authPath, "utf-8"));
    const existingCredential = existingAuth[profile.providerSlug];
    if (existingCredential && typeof existingCredential === "object" && (existingCredential as any).type === "oauth") {
      const { type: _type, ...oauth } = existingCredential as { type: "oauth" } & OAuthCredentials;
      if (hasCompleteOAuthCredentials(oauth) && isNewerOAuthCredential(oauth, profile.oauthCredentials)) {
        runtimeProfile = persistOAuthCredentialsForProfile(profile.id, profile.providerSlug, oauth) ?? profile;
      }
    }
  }

  writePrivateJson(join(agentDir, "models.json"), { providers: { [runtimeProfile.providerSlug]: piProviderConfig(runtimeProfile) } });
  const auth = authEntry(runtimeProfile);
  writePrivateJson(authPath, auth ? { [runtimeProfile.providerSlug]: auth } : {});

  const extensionPaths: string[] = [];
  if (requiresInternalExtension(runtimeProfile)) {
    const extDir = join(agentDir, "extensions");
    mkdirSync(extDir, { recursive: true });
    const extPath = join(extDir, `${runtimeProfile.providerSlug}.ts`);
    writeFileSync(extPath, extensionSource(runtimeProfile), "utf-8");
    extensionPaths.push(extPath);
  }

  return { agentDir, extensionPaths, profile: sanitizeProfile(runtimeProfile) };
}
