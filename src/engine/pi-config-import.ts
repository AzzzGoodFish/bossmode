import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  loadModelCredentialProfiles,
  MODEL_PROTOCOLS,
  saveModelCredentialProfile,
} from "./model-credentials.js";
import type {
  AvailableModelOption,
  ModelAuthType,
  ModelCredentialProfileInput,
  ModelDefinitionConfig,
  ModelProtocol,
  PiConfigImportPreview,
  PiConfigImportProviderPreview,
  PiConfigImportRequest,
  PiConfigImportResult,
  PublicModelCredentialProfile,
} from "../shared/types.js";

function readJsonc(path: string): any | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(raw);
}

function maskSecret(value: unknown): string {
  if (typeof value !== "string" || !value) return "configured";
  if (value.startsWith("!")) return "!command reference";
  if (/^[A-Z_][A-Z0-9_]*$/.test(value)) return value;
  if (value.length <= 8) return "****";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function modelToOption(model: any, profile: { id: string; name: string; providerSlug: string }, protocol: ModelProtocol): AvailableModelOption {
  return {
    ref: `${profile.providerSlug}/${model.id}`,
    provider: profile.providerSlug,
    providerSlug: profile.providerSlug,
    providerDisplayName: profile.name,
    modelId: model.id,
    displayName: model.name,
    profileId: profile.id,
    profileName: profile.name,
    protocol,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: Array.isArray(model.input) ? model.input : undefined,
    images: Array.isArray(model.input) ? model.input.includes("image") : false,
    metadataSource: "pi_catalog",
    credentialStatus: "configured",
  };
}

function authInfo(providerSlug: string, rawAuth: any, rawProvider: any): { authType: ModelAuthType; source: PiConfigImportProviderPreview["authSource"]; secretPreview: string; apiKey?: string; oauthCredentials?: Record<string, unknown>; oauthProviderId?: string } | null {
  const auth = rawAuth?.[providerSlug];
  if (auth?.type === "api_key" && typeof auth.key === "string") {
    return { authType: "api_key", source: "auth_json_api_key", secretPreview: maskSecret(auth.key), apiKey: auth.key };
  }
  if (auth?.type === "oauth") {
    const { type: _type, ...oauthCredentials } = auth;
    return { authType: "oauth", source: "auth_json_oauth", secretPreview: "OAuth token configured", oauthCredentials, oauthProviderId: providerSlug };
  }
  const apiKey = rawProvider?.apiKey;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return { authType: "api_key", source: apiKey.startsWith("!") ? "models_json_command" : "models_json_key", secretPreview: maskSecret(apiKey), apiKey };
  }
  return null;
}

function providerName(providerSlug: string, rawProvider: any, registry: ModelRegistry): string {
  return rawProvider?.name || registry.getProviderDisplayName(providerSlug) || providerSlug;
}

function protocolFor(models: any[], rawProvider: any): ModelProtocol | null {
  const api = rawProvider?.api || models[0]?.api;
  return MODEL_PROTOCOLS.includes(api) ? api : null;
}

function modelsForProvider(models: any[], providerSlug: string, rawProviderModels: any[] | undefined): ModelDefinitionConfig[] {
  const available = models.filter((m) => m.provider === providerSlug);
  const source = available.length > 0 ? available : (rawProviderModels || []).map((m) => ({ ...m, provider: providerSlug }));
  return source.map((m: any) => ({
    id: String(m.id),
    name: typeof m.name === "string" ? m.name : undefined,
    contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
    maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
    reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
    input: Array.isArray(m.input) ? m.input : ["text"],
    metadataSource: "pi_catalog" as const,
  })).filter((m) => m.id);
}

export function previewPiConfigImport(): PiConfigImportPreview {
  const piAgentDir = getAgentDir();
  const modelsPath = join(piAgentDir, "models.json");
  const authPath = join(piAgentDir, "auth.json");
  const modelsExists = existsSync(modelsPath);
  const authExists = existsSync(authPath);
  if (!modelsExists && !authExists) return { piAgentDir, found: false, providers: [], warnings: [] };

  const rawModels = readJsonc(modelsPath) || {};
  const rawAuth = readJsonc(authPath) || {};
  const authStorage = authExists ? AuthStorage.create(authPath) : AuthStorage.inMemory({});
  const modelRegistry = modelsExists ? ModelRegistry.create(authStorage, modelsPath) : ModelRegistry.create(authStorage);
  const available = modelRegistry.getAvailable();
  const existing = new Map(loadModelCredentialProfiles().map((p) => [p.providerSlug, p.id]));
  const providerSlugs = Array.from(new Set([
    ...Object.keys(rawModels.providers || {}),
    ...Object.keys(rawAuth || {}),
    ...available.map((m: any) => m.provider),
  ])).sort();

  const providers: PiConfigImportProviderPreview[] = providerSlugs.map((providerSlug) => {
    const rawProvider = rawModels.providers?.[providerSlug] || {};
    const providerModels = available.filter((m: any) => m.provider === providerSlug);
    const protocol = protocolFor(providerModels, rawProvider);
    const auth = authInfo(providerSlug, rawAuth, rawProvider);
    const warnings: string[] = [];
    if (!protocol) warnings.push(`Unsupported provider protocol: ${rawProvider?.api || providerModels[0]?.api || "unknown"}`);
    if (!auth) warnings.push("No importable credential found.");
    const importable = !!protocol && !!auth && modelsForProvider(available, providerSlug, rawProvider.models).length > 0;
    const displayName = providerName(providerSlug, rawProvider, modelRegistry);
    return {
      providerSlug,
      displayName,
      protocol: protocol || "openai-responses",
      baseUrl: rawProvider?.baseUrl || providerModels[0]?.baseUrl,
      authType: auth?.authType || "api_key",
      authSource: auth?.source || "models_json_key",
      secretPreview: auth?.secretPreview || "not configured",
      modelCount: modelsForProvider(available, providerSlug, rawProvider.models).length,
      models: providerModels.map((m: any) => modelToOption(m, { id: existing.get(providerSlug) || `import-${providerSlug}`, name: displayName, providerSlug }, protocol || "openai-responses")),
      existingProfileId: existing.get(providerSlug),
      importable,
      warnings,
    };
  });

  return { piAgentDir, found: true, providers, warnings: [] };
}

export function importPiConfig(input: PiConfigImportRequest = {}): PiConfigImportResult {
  const preview = previewPiConfigImport();
  const piAgentDir = preview.piAgentDir;
  const rawModels = readJsonc(join(piAgentDir, "models.json")) || {};
  const rawAuth = readJsonc(join(piAgentDir, "auth.json")) || {};
  const modelsPath = join(piAgentDir, "models.json");
  const authPath = join(piAgentDir, "auth.json");
  const authStorage = existsSync(authPath) ? AuthStorage.create(authPath) : AuthStorage.inMemory({});
  const modelRegistry = existsSync(modelsPath) ? ModelRegistry.create(authStorage, modelsPath) : ModelRegistry.create(authStorage);
  const available = modelRegistry.getAvailable();
  const selected = new Set(input.providers?.length ? input.providers : preview.providers.filter((p) => p.importable).map((p) => p.providerSlug));
  const overwrite = new Set(input.overwriteProviderSlugs || []);
  const profiles = loadModelCredentialProfiles();
  const imported: PublicModelCredentialProfile[] = [];
  const overwritten: PublicModelCredentialProfile[] = [];
  const skipped: PiConfigImportResult["skipped"] = [];
  const warnings: string[] = [];

  for (const item of preview.providers) {
    if (!selected.has(item.providerSlug)) continue;
    if (!item.importable) { skipped.push({ providerSlug: item.providerSlug, reason: item.warnings.join("; ") || "not importable" }); continue; }
    const existing = profiles.find((p) => p.providerSlug === item.providerSlug);
    if (existing && !overwrite.has(item.providerSlug)) { skipped.push({ providerSlug: item.providerSlug, reason: "already exists" }); continue; }
    const rawProvider = rawModels.providers?.[item.providerSlug] || {};
    const auth = authInfo(item.providerSlug, rawAuth, rawProvider);
    if (!auth) { skipped.push({ providerSlug: item.providerSlug, reason: "no credential" }); continue; }
    const models = modelsForProvider(available, item.providerSlug, rawProvider.models);
    const data: ModelCredentialProfileInput & { id?: string } = {
      ...(existing ? { id: existing.id } : {}),
      name: item.displayName,
      providerSlug: item.providerSlug,
      protocol: item.protocol,
      baseUrl: item.baseUrl,
      authType: auth.authType,
      apiKey: auth.apiKey,
      oauthProviderId: auth.oauthProviderId,
      oauthCredentials: auth.oauthCredentials,
      requestProfile: "standard",
      enabled: true,
      isDefault: existing?.isDefault ?? false,
      models,
    };
    try {
      const saved = saveModelCredentialProfile(data);
      existing ? overwritten.push(saved) : imported.push(saved);
    } catch (err: any) {
      skipped.push({ providerSlug: item.providerSlug, reason: err.message || String(err) });
    }
  }
  return { imported, overwritten, skipped, warnings };
}
