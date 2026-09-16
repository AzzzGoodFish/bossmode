import { join } from "node:path";
import { ensureCatalogRegistryRuntime } from "./catalog.js";
import { type OAuthCredentials, type OAuthLoginCallbacks, type OAuthLoginAdapter, hasCompleteOAuthCredentials, readModelCredential, modifyModelCredential, DUMMY_API_KEY, normalizeRuntimeBaseUrl, shouldUseSdkBuiltinCatalog, loadModelCredentialProfiles, sanitizeProfile, resolveCredentialProfileForModel } from "../models.js";
import { getBossmodeDir } from "../../files/layout.js";
import { type Credential, type CredentialInfo, type CredentialStore, type AuthInteraction } from "@earendil-works/pi-ai";
import { type ModelCredentialProfile, type PublicModelCredentialProfile } from "../../kernel/types.js";
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
        return callbacks.onPrompt({ message: prompt.message, placeholder: prompt.placeholder });
      },
    };
    const credential = await runtime.login(providerId, "oauth", interaction);
    if (credential.type !== "oauth" || !hasCompleteOAuthCredentials(credential)) throw new Error(`OAuth provider ${providerId} did not return complete credentials`);
    const { type: _type, ...credentials } = credential;
    return credentials as OAuthCredentials;
  }
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
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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

const databaseRuntimeProviders = new WeakMap<ModelRuntime, Set<string>>();

export async function createDatabaseModelRuntime(credentials: CredentialStore, preferredProfileId?: string): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, modelsStore: createDatabaseModelsStore(), allowModelNetwork: false });
  await refreshDatabaseModelRuntime(runtime, preferredProfileId);
  return runtime;
}

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

function safeFsSegment(s: string): string {
  return String(s || "_").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

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
