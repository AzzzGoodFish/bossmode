import { AsyncLocalStorage } from "node:async_hooks";
import {azureCredentialEnv,type ProviderConnection} from '../connection-config.js';
import { join } from "node:path";
import { ensureCatalogRegistryRuntime } from "./catalog.js";
import { type OAuthCredentials, type OAuthLoginCallbacks, type OAuthLoginAdapter, hasCompleteOAuthCredentials, readModelCredential, modifyModelCredential, DUMMY_API_KEY, normalizeRuntimeBaseUrl, shouldUseSdkBuiltinCatalog, loadModelCredentialProfiles, sanitizeProfile, resolveCredentialProfileForModel } from "../models.js";
import { getBossmodeDir } from "../../files/layout.js";
import { type Credential, type CredentialInfo, type CredentialStore, type AuthInteraction } from "@earendil-works/pi-ai";
import { type ModelCredentialProfile, type PublicModelCredentialProfile } from "../models.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDatabaseModelsStore } from "../catalog.js";
import { mkdirSync } from "node:fs";
export class PiAiOAuthLoginAdapter implements OAuthLoginAdapter {
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
        return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder, allowEmpty: prompt.type==='text', secret:prompt.type==='secret' });
      },
    };
    const credential = await provider.auth.oauth.login({...interaction,signal:callbacks.signal??new AbortController().signal});
    if (credential.type !== "oauth" || !hasCompleteOAuthCredentials(credential)) throw new Error(`OAuth provider ${providerId} did not return complete credentials`);
    const { type: _type, ...credentials } = credential;
    return credentials as OAuthCredentials;
  }
}

// Like pi-web's API-key adapter: use the SDK login method, then persist the
// returned credential ourselves. ModelRuntime.login would refresh the remote catalog.
export async function loginProviderApiKey(providerId:string,apiKey:string|undefined,connection:ProviderConnection,signal:AbortSignal):Promise<{apiKey?:string;env?:Record<string,string>}> {
 const runtime=await ensureCatalogRegistryRuntime(),login=runtime.getProvider(providerId)?.auth.apiKey?.login;
 if(!login)throw Error(`Provider ${providerId} does not support API key login`);
 const s=connection.settings,route=connection.route;
 const choice:Record<string,string>={'aws-token':'bearer-token','aws-profile':'aws-profile','aws-chain':'credential-chain','vertex-key':'api-key','vertex-adc':'adc','vertex-file':'service-account'};
 const text=providerId==='cloudflare-ai-gateway'?[s.account!,s.gateway!]:providerId==='cloudflare-workers-ai'?[s.account!]:route==='aws-profile'?[s.profile!]:route==='aws-chain'?['']:route==='vertex-adc'?[s.project!,s.location!]:route==='vertex-file'?[s.project!,s.location!,s.path!]:[];
 let index=0,secretRead=false;
 const credential=await login({signal,notify:()=>{},prompt:async prompt=>{signal.throwIfAborted();if(prompt.type==='select'){const selected=choice[route];if(selected&&prompt.options.some(option=>option.id===selected))return selected;throw Error('供应商需要其他认证方式，请重新选择。');}if(prompt.type==='secret'&&!secretRead&&apiKey?.trim()){secretRead=true;return apiKey.trim();}if(prompt.type==='text'&&index<text.length)return text[index++];throw Error('供应商需要额外认证参数，当前表单无法完成此接入。');}});
 signal.throwIfAborted();if(credential.type!=='api_key'||index!==text.length)throw Error('供应商未返回预期的凭证配置。');
 return {apiKey:credential.key,env:providerId==='azure-openai-responses'?{...credential.env,...azureCredentialEnv(connection)}:credential.env};
}

export function getBossmodePiRuntimeRoot(): string {
  return join(getBossmodeDir(), "pi-agent", "runtime");
}

class ProfileCredentialStore implements CredentialStore {
  constructor(private readonly profileId: string, private readonly providerSlug: string) {}
  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.providerSlug ? readModelCredential(this.profileId, this.providerSlug) : undefined;
  }
  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read(this.providerSlug);
    return credential ? [{ providerId: this.providerSlug, type: credential.type }] : [];
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return providerId === this.providerSlug ? modifyModelCredential(this.profileId, this.providerSlug, fn) : undefined;
  }
  async delete(_providerId: string): Promise<void> { /* Profile lifecycle owns deletion. */ }
}

export function createCredentialStore(profile: Pick<ModelCredentialProfile, "id" | "providerSlug">): CredentialStore {
  return new ProfileCredentialStore(profile.id, profile.providerSlug);
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
      // Pi requires numeric SDK costs. Omitted prices remain unknown in our DB/API.
      cost: { input: m.cost?.input??0, output: m.cost?.output??0, cacheRead: m.cost?.cacheRead??0, cacheWrite: m.cost?.cacheWrite??0 },
    })),
  };
}



function apiForProfile(profile: ModelCredentialProfile): string {
  return profile.protocol;
}

export interface PiCredentialExport {
  agentDir: string;
  extensionPaths: string[];
  profile?: PublicModelCredentialProfile;
}

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

const databaseRuntimeProviders = new WeakMap<ModelRuntime, Map<string, string>>();

export async function createDatabaseModelRuntime(credentials: CredentialStore, preferredProfileId?: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: createDatabaseModelsStore(), allowModelNetwork: false });
  await refreshDatabaseModelRuntime(runtime, preferredProfileId);
  return runtime;
}

export async function refreshDatabaseModelRuntime(
  runtime: ModelRuntime, preferredProfileId?: string, options: { skipUnchanged?: boolean } = {},
): Promise<void> {
  const providers = buildAllProvidersCatalog(preferredProfileId);
  const registered = databaseRuntimeProviders.get(runtime) ?? new Map<string, string>();
  databaseRuntimeProviders.set(runtime, registered);
  const changed: string[] = [];
  for (const id of registered.keys()) {
    if (!(id in providers)) {
      runtime.unregisterProvider(id);
      registered.delete(id);
      changed.push(id);
    }
  }
  for (const [id, config] of Object.entries(providers)) {
    const fingerprint = JSON.stringify(config);
    if (registered.get(id) === fingerprint) continue;
    // SDK registrations merge, so remove an old registration first to avoid
    // retaining deleted headers/endpoint overrides. Unchanged providers must
    // not be re-registered: every registration starts an SDK-wide refresh.
    if (registered.has(id)) {
      runtime.unregisterProvider(id);
      registered.delete(id);
    }
    runtime.registerProvider(id, config as Parameters<ModelRuntime["registerProvider"]>[1]);
    registered.set(id, fingerprint);
    changed.push(id);
  }
  // Switching models/accounts is not catalog discovery. Authentication still
  // happens through session.setModel using the new profile-bound snapshot.
  if (options.skipUnchanged && changed.length === 0) return;
  await runtime.refresh({ allowNetwork: false, ...(options.skipUnchanged ? { providers: changed } : {}) });
}

function safeFsSegment(s: string): string {
  return String(s || "_").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function resolvePiAgentDir(memberId: string): string {
  return join(getBossmodePiRuntimeRoot(), "members", safeFsSegment(memberId));
}

export function exportPiConfigForMember(args: {
  memberId: string;
  modelRef: string;
  credentialId?: string;
}): PiCredentialExport | null {
  const profile = resolveCredentialProfileForModel({ modelRef: args.modelRef, credentialId: args.credentialId });
  if (!profile) return null;

  const agentDir = resolvePiAgentDir(args.memberId);
  mkdirSync(agentDir, { recursive: true });

  // Parent runtime registers buildAllProvidersCatalog(profile.id) in memory and
  // passes createDatabaseModelsStore(); agentDir is retained for SDK sessions/assets.
  return { agentDir, extensionPaths: [], profile: sanitizeProfile(profile) };
}

// -- SDK model credential binding (moved from agent/runtime/model-credential-binding.ts) --
type Profile = Parameters<typeof createCredentialStore>[0];

/**
 * Each SDK model snapshot owns a fixed profile. Only secrets are read live.
 * An auth operation retains that store across the SDK's read/modify awaits. */
export class ModelCredentialBinding implements CredentialStore {
  private readonly request = new AsyncLocalStorage<CredentialStore>();
  private readonly models = new WeakMap<object, CredentialStore>();
  private readonly initial: CredentialStore;
  private currentModel: () => object | undefined = () => undefined;

  constructor(profile: Profile) {
    this.initial = createCredentialStore(profile);
  }

  bind<T extends object>(model: T, profile: Profile): T {
    // Same model + another account still needs a distinct request snapshot.
    const bound = { ...model };
    this.models.set(bound, createCredentialStore(profile));
    return bound;
  }

  followSession(getModel: () => object | undefined): void {
    this.currentModel = getModel;
  }

  private forModel(model: object): CredentialStore {
    const store = this.models.get(model);
    if (!store) throw new Error("Model has no credential binding");
    return store;
  }

  private current(): CredentialStore {
    const scoped = this.request.getStore();
    if (scoped) return scoped;
    const model = this.currentModel();
    return model ? this.forModel(model) : this.initial;
  }

  run<T>(model: object | undefined, fn: () => T): T {
    return this.request.run(model ? this.forModel(model) : this.current(), fn);
  }

  runProfile<T>(profile: Profile, fn: () => T): T {
    return this.request.run(createCredentialStore(profile), fn);
  }

  /** SDK request and catalog entry points; no SDK history/state replacement. */
  attach(runtime: ModelRuntime): void {
    const getAuth = runtime.getAuth.bind(runtime);
    runtime.getAuth = (model, overrides) => this.run(
      typeof model === "string" ? undefined : model,
      () => typeof model === "string" ? getAuth(model, overrides) : getAuth(model, overrides),
    );
    const refresh = runtime.refresh.bind(runtime);
    runtime.refresh = (options) => this.run(undefined, () => refresh(options));
    const checkAuth = runtime.checkAuth.bind(runtime);
    runtime.checkAuth = (provider) => this.run(undefined, () => checkAuth(provider));
  }

  read(...args: Parameters<CredentialStore["read"]>): ReturnType<CredentialStore["read"]> {
    return this.current().read(...args);
  }
  list(): ReturnType<CredentialStore["list"]> { return this.current().list(); }
  modify(...args: Parameters<CredentialStore["modify"]>): ReturnType<CredentialStore["modify"]> {
    return this.current().modify(...args);
  }
  delete(...args: Parameters<CredentialStore["delete"]>): ReturnType<CredentialStore["delete"]> {
    return this.current().delete(...args);
  }
}
