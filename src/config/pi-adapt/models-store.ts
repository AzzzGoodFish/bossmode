import { sqliteBoolean, type Database } from "../../data/database.js";
import type { DiskCatalogCache, ProviderModelsStoreEntry } from "../model-catalog.js";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { defined, objectJson, parseObject } from "../../kernel/json.js";

/** SDK metadata is heterogeneous; queryable model identity/capabilities remain columns. */
export class CatalogRepository {
  constructor(private readonly db: Database) {}
  private models(id: string): any[] {
    return this.db.all<any>("SELECT * FROM catalog_models WHERE snapshot_id=? ORDER BY position",id).map(r => ({
      ...parseObject(r.extension_json), provider:r.provider,id:r.id,
      ...defined({name:r.name,api:r.api,baseUrl:r.base_url,contextWindow:r.context_window,maxTokens:r.max_tokens,
        reasoning:r.reasoning === null ? undefined : !!r.reasoning,input:r.input_json ? JSON.parse(r.input_json) : undefined}),
    }));
  }
  private writeModels(id: string, models: any[]): void {
    this.db.run("DELETE FROM catalog_models WHERE snapshot_id=?",id);
    models.forEach((m,i) => {
      if (!m || typeof m.id !== "string" || typeof m.provider !== "string") throw new Error("Invalid catalog model identity");
      const {provider, id:modelId, name,api,baseUrl,contextWindow,maxTokens,reasoning,input,...extension} = m;
      if (input !== undefined && !Array.isArray(input)) throw new Error("Invalid catalog model input");
      this.db.run("INSERT INTO catalog_models VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",id,provider,modelId,i,name ?? null,api ?? null,baseUrl ?? null,
        contextWindow ?? null,maxTokens ?? null,sqliteBoolean(reasoning),input === undefined ? null : JSON.stringify(input),objectJson(extension));
    });
  }
  remote(): DiskCatalogCache | null {
    const r=this.db.get<any>("SELECT * FROM catalog_snapshots WHERE id='remote'");
    return r ? {models:this.models("remote"),fetchedAt:r.fetched_at,updatedAt:new Date(r.fetched_at).toISOString()} : null;
  }
  importRemote(cache: DiskCatalogCache): boolean {
    if (!Number.isFinite(cache.fetchedAt) || !Array.isArray(cache.models)) throw new Error("Invalid catalog snapshot");
    return this.db.transaction(tx => {
      const current = this.remote();
      if (current && current.fetchedAt > cache.fetchedAt) return false;
      tx.run("INSERT OR REPLACE INTO catalog_snapshots VALUES ('remote',?,NULL,NULL,NULL)",cache.fetchedAt);
      this.writeModels("remote",cache.models);
      return true;
    });
  }
  overlays(): Record<string, ProviderModelsStoreEntry> {
    return Object.fromEntries(this.db.all<any>("SELECT * FROM catalog_snapshots WHERE id LIKE 'provider:%'").map(r => [r.id.slice(9),{
      models:this.models(r.id),...defined({lastModified:r.last_modified,checkedAt:r.checked_at,etag:r.etag}),
    }]));
  }
  importOverlay(provider: string, entry: ProviderModelsStoreEntry): void {
    if (!provider || !Array.isArray(entry.models)) throw new Error("Invalid provider catalog");
    this.db.transaction(tx => {
      const id=`provider:${provider}`;
      const current=tx.get<any>("SELECT checked_at FROM catalog_snapshots WHERE id=?",id);
      if (current?.checked_at != null && entry.checkedAt != null && current.checked_at > entry.checkedAt) return;
      tx.run("INSERT OR REPLACE INTO catalog_snapshots VALUES (?,NULL,?,?,?)",id,entry.lastModified ?? null,entry.checkedAt ?? null,entry.etag ?? null);
      this.writeModels(id,entry.models.map(m => ({...m,provider:m.provider ?? provider})));
    });
  }
  deleteOverlay(provider: string): void { this.db.run("DELETE FROM catalog_snapshots WHERE id=?",`provider:${provider}`); }
  importOverlays(overlays: Record<string,ProviderModelsStoreEntry>): void {
    this.db.transaction(() => { for (const [provider,entry] of Object.entries(overlays)) this.importOverlay(provider,entry); });
  }
}

/** Native Pi adapter; parent supplies this to ModelRuntime.create(modelsStore). */
export class DatabaseModelsStore implements ModelsStore {
  constructor(private readonly repository: CatalogRepository) {}
  async read(providerId: string): Promise<ModelsStoreEntry | undefined> { return this.repository.overlays()[providerId] as ModelsStoreEntry | undefined; }
  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> { this.repository.importOverlay(providerId,{...entry,models:[...entry.models]}); }
  async delete(providerId: string): Promise<void> { this.repository.deleteOverlay(providerId); }
}
