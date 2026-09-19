export interface ModelDefinitionConfig {id:string;name?:string;contextWindow?:number;maxTokens?:number;reasoning?:boolean;input?:Array<"text"|"image">;thinkingLevelMap?:Partial<Record<"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max",string|null>>;compat?:Record<string,unknown>;metadataSource?:"endpoint"|"pi_catalog"|"unknown";}
export interface PublicModelProvider {providerSlug:string;displayName:string;authModes:Array<"api_key"|"oauth">;defaultAuthMode:"api_key"|"oauth";modelCount:number;sampleModels:string[];protocol?:ModelProtocol;logoKey?:string;}
import { getCatalogRegistrySync, ensureCatalogRegistry, getCatalogRuntimeSync, DatabaseModelsStore } from "./pi-adapt/catalog.js";
import { logger } from "../kernel/logger.js";
import { readConfig, writeConfig } from "./settings.js";
import { getDatabase, sqliteBoolean, type Database } from "../data/database.js";
import { defined, objectJson, parseObject } from "../kernel/json.js";
export const MODEL_PROTOCOLS=["openai-completions","openai-responses","openai-codex-responses","anthropic-messages","azure-openai-responses","google-generative-ai","google-gemini-cli","google-vertex","bedrock-converse-stream","mistral-conversations"] as const;
export type ModelProtocol=(typeof MODEL_PROTOCOLS)[number];
const OAUTH_PROVIDERS = ["anthropic", "github-copilot", "google-gemini-cli", "google-antigravity", "openai-codex"] as const;
const BUILTIN_API_KEY_PROVIDERS = new Set(["anthropic", "openai", "xai", "openrouter", "google", "mistral", "deepseek", "groq", "cerebras", "zai", "moonshotai", "moonshotai-cn", "minimax", "minimax-cn", "huggingface", "fireworks", "together", "kimi-coding"]);
type ModelDiscoveredMetadata = {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  thinkingLevelMap?: ModelDefinitionConfig["thinkingLevelMap"];
  compat?: ModelDefinitionConfig["compat"];
};
const THINKING_LEVEL_MAP_KEYS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export function validateThinkingLevelMap(raw: unknown): ModelDefinitionConfig["thinkingLevelMap"] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("thinkingLevelMap must be an object");
  const out: NonNullable<ModelDefinitionConfig["thinkingLevelMap"]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!THINKING_LEVEL_MAP_KEYS.has(key)) throw new Error(`Unknown thinking level in map: ${key}`);
    if (value !== null && typeof value !== "string") throw new Error(`thinkingLevelMap.${key} must be a string or null`);
    if (typeof value === "string" && !value.trim()) throw new Error(`thinkingLevelMap.${key} cannot be empty (use null to disable)`);
    out[key as keyof typeof out] = value === null ? null : value.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

export function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const num = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(num) && num > 0) return num;
  }
  return undefined;
}

export function explicitBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) if (typeof value === "boolean") return value;
  return undefined;
}

function clonePlainObject<T extends Record<string, unknown>>(value: unknown): T | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try { return JSON.parse(JSON.stringify(value)) as T; } catch { return undefined; }
}

export function modelSdkMetadata(raw: any): Pick<ModelDefinitionConfig, "thinkingLevelMap" | "compat"> {
  return {
    ...(clonePlainObject(raw?.thinkingLevelMap) ? { thinkingLevelMap: clonePlainObject(raw.thinkingLevelMap) } : {}),
    ...(clonePlainObject(raw?.compat) ? { compat: clonePlainObject(raw.compat) } : {}),
  };
}

const sameJson=(a:unknown,b:unknown):boolean=>JSON.stringify(a??null)===JSON.stringify(b??null);
function metadataKey(value:ModelDiscoveredMetadata):string{return JSON.stringify({...value,...(value.input?{input:[...value.input].sort()}: {})});}
function applyConsistentMetadataFallback(matches:ModelDiscoveredMetadata[]):ModelDiscoveredMetadata|null{
  const first=matches[0];if(!first||metadataKey(first)==="{}")return null;
  const key=metadataKey(first);return matches.every(value=>metadataKey(value)===key)?first:null;
}

function loadBundledCatalogSync(): any[] {
  const registry = getCatalogRegistrySync();
  if (!registry) return [];
  try {
    return typeof registry.getAll === "function" ? registry.getAll() : [];
  } catch {
    return [];
  }
}


export async function ensurePiCatalogWarm(): Promise<void> {
  try { await ensureCatalogRegistry(); } catch { /* leave cache cold; sync readers fall back gracefully */ }
  // Offline: rehydrate last successful pi.dev overlay from disk (no network).
  getCatalog();
}

const PI_DEV_CATALOG_BASE = "https://pi.dev";

export async function refreshPiCatalogFromNetwork(options?: { timeoutMs?: number }): Promise<{source:CatalogRefreshSource;error?:string;fetchedAt?:number|null}> {
  try {
    await ensureCatalogRegistry();
    const bundled=loadBundledCatalogSync();
    if(!bundled.length)return {source:getCatalog().source,error:"Packaged model catalog is empty"};
    const providers=new Set([...bundled.map(model=>String(model.provider)),...BUILTIN_API_KEY_PROVIDERS,...OAUTH_PROVIDERS]);
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),options?.timeoutMs??15_000);
    const merged=new Map(bundled.map(model=>[`${model.provider}/${model.id}`,model]));
    const overlays:Record<string,ProviderModelsStoreEntry>={};let fetched=0,lastError:string|undefined;
    try {
      for(const provider of providers)try{
        const response=await fetch(new URL(`/api/models/providers/${encodeURIComponent(provider)}`,PI_DEV_CATALOG_BASE),{headers:{accept:"application/json"},signal:controller.signal});
        if(!response.ok){if(response.status!==404&&response.status!==501)lastError=`pi.dev catalog ${provider}: HTTP ${response.status}`;continue;}
        const value=await response.json() as any,items=Array.isArray(value)?value:Array.isArray(value?.models)?value.models:Object.values(value??{});
        const models=items.filter((item:any)=>item&&item.id).map((item:any)=>({...item,provider,id:String(item.id)}));
        if(!models.length)continue;fetched++;models.forEach((model:any)=>merged.set(`${provider}/${model.id}`,model));
        overlays[provider]={models,lastModified:Date.parse(response.headers.get("last-modified")??"")||Date.now(),checkedAt:Date.now(),etag:response.headers.get("etag")??undefined};
      }catch(error){lastError=error instanceof Error?error.message:String(error);}
    }finally{clearTimeout(timer);}
    if(!fetched){const snap=getCatalog();return {source:snap.source,error:lastError??"Remote catalog returned no provider data",fetchedAt:snap.fetchedAt};}
    const models=[...merged.values()],fetchedAt=Date.now();getDatabase().transaction(()=>{commitRemoteCatalog(models,fetchedAt);publishProviderModels(overlays);});
    return {source:"remote",fetchedAt};
  } catch(error) {
    const snap=getCatalog();return {source:snap.source,error:error instanceof Error?error.message:String(error),fetchedAt:snap.fetchedAt};
  }
}

export async function loadPiCatalogModels(): Promise<any[]> {
  const models = getCatalogModels();
  if (models.length > 0) return models;
  try {
    const registry = await ensureCatalogRegistry();
    return typeof registry.getAll === "function" ? registry.getAll() : [];
  } catch {
    return [];
  }
}

export function loadPiCatalogModelsSync(): any[] {
  return getCatalogModels();
}

export function getCatalogStatus(): CatalogSnapshot & { freshnessLabel: string } {
  const snap = getCatalog();
  return { ...snap, freshnessLabel: formatCatalogFreshness(snap) };
}

export const DEFAULT_CATALOG_AUTO_REFRESH_DAYS = 7;

export function getCatalogAutoRefreshIntervalDays(): number {
  const v = readConfig().catalog?.autoRefreshIntervalDays;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return DEFAULT_CATALOG_AUTO_REFRESH_DAYS;
}

export function setCatalogAutoRefreshIntervalDays(days: number): number {
  const n = Math.max(0, Math.floor(Number(days) || 0));
  const cfg = readConfig();
  cfg.catalog = { ...(cfg.catalog || {}), autoRefreshIntervalDays: n };
  writeConfig(cfg);
  return n;
}

export function isCatalogRefreshDue(now = Date.now()): boolean {
  const days = getCatalogAutoRefreshIntervalDays();
  if (days <= 0) return false;
  const snap = getCatalog();
  // Never successfully pulled remote → due.
  if (snap.fetchedAt == null) return true;
  return now - snap.fetchedAt >= days * 24 * 60 * 60 * 1000;
}

export function getCatalogSettingsPublic(): {
  autoRefreshIntervalDays: number;
  refreshDue: boolean;
  status: CatalogSnapshot & { freshnessLabel: string };
} {
  return {
    autoRefreshIntervalDays: getCatalogAutoRefreshIntervalDays(),
    refreshDue: isCatalogRefreshDue(),
    status: getCatalogStatus(),
  };
}

function displayNameForProvider(providerSlug: string): string {
  const registry = getCatalogRegistrySync();
  if (!registry) return providerSlug;
  try {
    return registry.getProviderDisplayName(providerSlug) || providerSlug;
  } catch {
    return providerSlug;
  }
}

export function oauthProviderIds(): Set<string> {
  const runtime = getCatalogRuntimeSync();
  if (!runtime) return new Set(OAUTH_PROVIDERS as readonly string[]);
  try {
    return new Set(runtime.getProviders().filter((p) => p.auth.oauth).map((p) => p.id));
  } catch {
    return new Set(OAUTH_PROVIDERS as readonly string[]);
  }
}

export function modelsForBuiltinProvider(providerSlug: string, _baseUrlOverride?: string): ModelDefinitionConfig[] {
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

export function protocolForBuiltinProvider(providerSlug: string): ModelProtocol {
  const api = firstBuiltinModel(providerSlug)?.api;
  return MODEL_PROTOCOLS.includes(api) ? api : "openai-responses";
}

export function baseUrlForBuiltinProvider(providerSlug: string, override?: string): string {
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

function catalogMetadata(m: any): ModelDiscoveredMetadata {
  return {
    contextWindow: positiveNumber(m.contextWindow),
    maxTokens: positiveNumber(m.maxTokens, m.max_output_tokens),
    reasoning: explicitBoolean(m.reasoning, m.supports_reasoning),
    input: Array.isArray(m.input) ? m.input : undefined,
    ...modelSdkMetadata(m),
  };
}

export function piCatalogFallbackMetadata(modelId: string, providerSlug: string, catalog: any[]): ModelDiscoveredMetadata | null {
  const exact = catalog.find((m) => m.provider === providerSlug && m.id === modelId);
  if (exact) return catalogMetadata(exact);

  const matches = catalog
    .filter((m) => m.id === modelId)
    .map(catalogMetadata);

  return applyConsistentMetadataFallback(matches);
}

export function applyPiCatalogFallback(model: ModelDefinitionConfig, providerSlug: string, catalog: any[]): ModelDefinitionConfig {
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



export function createDatabaseModelsStore(): DatabaseModelsStore { return new DatabaseModelsStore({ overlays: readProviderOverlays, importOverlay: importProviderOverlay, deleteOverlay: deleteProviderOverlay }); }

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

export interface ProviderModelsStoreEntry {
  models: any[];
  lastModified?: number;
  checkedAt?: number;
  etag?: string;
}

export function getCatalog(): CatalogSnapshot {
  const stored=readRemoteCatalog(getDatabase()),models=stored?.models.length?stored.models:loadBundledCatalogSync();
  const fetchedAt=stored?.models.length?stored.fetchedAt:null,source=fetchedAt===null?"bundled":"remote";
  return {models,source,fetchedAt,fetchedAtIso:fetchedAt?new Date(fetchedAt).toISOString():null,modelCount:models.length};
}

export function getCatalogModels(): any[] {
  return getCatalog().models;
}

export function commitRemoteCatalog(models: any[], fetchedAt: number = Date.now()): void {
  if (!Array.isArray(models) || models.length === 0) {
    logger.warn("catalog", "commitRemoteCatalog ignored empty models");
    return;
  }
  if (!importRemoteCatalog({ models, fetchedAt, updatedAt: new Date(fetchedAt).toISOString() }, getDatabase())) return;
  getDatabase().afterCommit(() => logger.info("catalog", "remote catalog committed", {
    modelCount: models.length,
    fetchedAt: new Date(fetchedAt).toISOString(),
  }));
}

export function commitProviderOverlays(overlays: Record<string, ProviderModelsStoreEntry>): void {
  importProviderOverlays(overlays, getDatabase());
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

const catalogListeners = new Set<() => void | Promise<void>>();

export function onCatalogChanged(listener: () => void | Promise<void>): () => void {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}

export async function notifyCatalogChanged(): Promise<void> {
  await Promise.all([...catalogListeners].map(listener => listener()));
}

function readCatalogModels(id: string, db: Database = getDatabase()): any[] {
    return db.all<any>("SELECT * FROM catalog_models WHERE snapshot_id=? ORDER BY position",id).map(r => ({
      ...parseObject(r.extension_json), provider:r.provider,id:r.id,
      ...defined({name:r.name,api:r.api,baseUrl:r.base_url,contextWindow:r.context_window,maxTokens:r.max_tokens,
        reasoning:r.reasoning === null ? undefined : !!r.reasoning,input:r.input_json ? JSON.parse(r.input_json) : undefined}),
    }));
  }

function writeCatalogModels(id: string, models: any[], db: Database = getDatabase()): void {
    db.run("DELETE FROM catalog_models WHERE snapshot_id=?",id);
    models.forEach((m,i) => {
      if (!m || typeof m.id !== "string" || typeof m.provider !== "string") throw new Error("Invalid catalog model identity");
      const {provider, id:modelId, name,api,baseUrl,contextWindow,maxTokens,reasoning,input,...extension} = m;
      if (input !== undefined && !Array.isArray(input)) throw new Error("Invalid catalog model input");
      db.run("INSERT INTO catalog_models VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",id,provider,modelId,i,name ?? null,api ?? null,baseUrl ?? null,
        contextWindow ?? null,maxTokens ?? null,sqliteBoolean(reasoning),input === undefined ? null : JSON.stringify(input),objectJson(extension));
    });
  }

export function readRemoteCatalog(db: Database = getDatabase()): DiskCatalogCache | null {
    const r=db.get<any>("SELECT * FROM catalog_snapshots WHERE id='remote'");
    return r ? {models:readCatalogModels("remote", db),fetchedAt:r.fetched_at,updatedAt:new Date(r.fetched_at).toISOString()} : null;
  }

export function importRemoteCatalog(cache: DiskCatalogCache, db: Database = getDatabase()): boolean {
    if (!Number.isFinite(cache.fetchedAt) || !Array.isArray(cache.models)) throw new Error("Invalid catalog snapshot");
    return db.transaction(tx => {
      const current = readRemoteCatalog(db);
      if (current && current.fetchedAt > cache.fetchedAt) return false;
      tx.run("INSERT OR REPLACE INTO catalog_snapshots VALUES ('remote',?,NULL,NULL,NULL)",cache.fetchedAt);
      writeCatalogModels("remote",cache.models, db);
      return true;
    });
  }

export function readProviderOverlays(db: Database = getDatabase()): Record<string, ProviderModelsStoreEntry> {
    return Object.fromEntries(db.all<any>("SELECT * FROM catalog_snapshots WHERE id LIKE 'provider:%'").map(r => [r.id.slice(9),{
      models:readCatalogModels(r.id, db),...defined({lastModified:r.last_modified,checkedAt:r.checked_at,etag:r.etag}),
    }]));
  }

export function importProviderOverlay(provider: string, entry: ProviderModelsStoreEntry, db: Database = getDatabase()): void {
    if (!provider || !Array.isArray(entry.models)) throw new Error("Invalid provider catalog");
    db.transaction(tx => {
      const id=`provider:${provider}`;
      const current=tx.get<any>("SELECT checked_at FROM catalog_snapshots WHERE id=?",id);
      if (current?.checked_at != null && entry.checkedAt != null && current.checked_at > entry.checkedAt) return;
      tx.run("INSERT OR REPLACE INTO catalog_snapshots VALUES (?,NULL,?,?,?)",id,entry.lastModified ?? null,entry.checkedAt ?? null,entry.etag ?? null);
      writeCatalogModels(id,entry.models.map(m => ({...m,provider:m.provider ?? provider})), db);
    });
  }

export function deleteProviderOverlay(provider: string, db: Database = getDatabase()): void { db.run("DELETE FROM catalog_snapshots WHERE id=?",`provider:${provider}`); }

export function importProviderOverlays(overlays: Record<string,ProviderModelsStoreEntry>, db: Database = getDatabase()): void {
    db.transaction(() => { for (const [provider,entry] of Object.entries(overlays)) importProviderOverlay(provider,entry, db); });
  }

export function publishProviderModels(overlays: Record<string, ProviderModelsStoreEntry>): void {
  commitProviderOverlays(overlays);
  getDatabase().afterCommit(() => {
    void notifyCatalogChanged().catch(() => logger.warn("catalog", "live registry refresh failed"));
  });
}
