import { sqliteBoolean, type Database } from "../database.js";
import type { ModelCredentialProfile, ModelDefinitionConfig } from "../../kernel/types.js";
import { defined, optionalJson, parseObject } from "../../kernel/json.js";

export interface CredentialImport { profiles: ModelCredentialProfile[]; migrations: string[] }
/** Internal secret repository. Revisions protect refreshes across asynchronous provider IO. */
export class ModelCredentialsRepository {
  constructor(private readonly db: Database) {}
  private nextRevision(): number {
    this.db.run("UPDATE credential_revision SET value=value+1 WHERE id=1");
    return this.db.get<{value:number}>("SELECT value FROM credential_revision WHERE id=1")!.value;
  }
  revision(id: string): number | null { return this.db.get<{revision: number}>("SELECT revision FROM model_profiles WHERE id=?", id)?.revision ?? null; }
  /** Profile identity, secret and revision from one short synchronous snapshot. */
  snapshot(id: string): { profile: ModelCredentialProfile | null; revision: number | null } {
    return this.db.transaction(() => ({
      profile: this.read().profiles.find(p => p.id === id) ?? null,
      revision: this.revision(id),
    }));
  }
  read(): CredentialImport {
    return { profiles: this.db.all<any>("SELECT * FROM model_profiles ORDER BY position").map(r => {
      const secret = this.db.get<any>("SELECT * FROM model_secrets WHERE profile_id=?", r.id);
      const headers = Object.fromEntries(this.db.all<any>("SELECT name,value FROM model_headers WHERE profile_id=?", r.id).map(h => [h.name,h.value]));
      const custom = this.db.all<any>("SELECT * FROM model_customizations WHERE profile_id=?", r.id);
      const addedModels = this.models(r.id, "added");
      const disabled = custom.filter(c => c.disabled).map(c => c.model_id);
      const contextWindowOverride = Object.fromEntries(custom.filter(c => c.context_window !== null).map(c => [c.model_id,c.context_window]));
      return {
        id: r.id, name: r.name, providerSlug: r.provider_slug, protocol: r.protocol, authType: r.auth_type,
        requestProfile: r.request_profile, enabled: !!r.enabled, isDefault: !!r.is_default, createdAt: r.created_at, updatedAt: r.updated_at,
        ...defined({ profileKind: r.profile_kind, baseUrl: r.base_url, oauthProviderId: r.oauth_provider_id,
          authHeader: r.auth_header === null ? undefined : !!r.auth_header, apiKey: secret?.api_key,
          oauthCredentials: secret?.oauth_json ? parseObject(secret.oauth_json) : undefined }),
        ...(Object.keys(headers).length ? { headers } : {}), models: this.models(r.id,"model"),
        ...(custom.length || addedModels.length ? { modelCustomizations: { disabled, contextWindowOverride, addedModels } } : {}),
      } as ModelCredentialProfile;
    }), migrations: this.db.all<{id: string}>("SELECT id FROM credential_migrations ORDER BY id").map(r => r.id) };
  }
  private models(profileId: string, kind: string): ModelDefinitionConfig[] {
    return this.db.all<any>("SELECT * FROM model_definitions WHERE profile_id=? AND kind=? ORDER BY position", profileId, kind).map(r => ({
      id: r.id, ...defined({ name:r.name, contextWindow:r.context_window, maxTokens:r.max_tokens,
        reasoning:r.reasoning === null ? undefined : !!r.reasoning, metadataSource:r.metadata_source,
        input:r.input_text === null ? undefined : [...(r.input_text ? ["text"] : []), ...(r.input_image ? ["image"] : [])],
        thinkingLevelMap:r.thinking_json ? parseObject(r.thinking_json) : undefined, compat:r.compat_json ? parseObject(r.compat_json) : undefined }),
    } as ModelDefinitionConfig));
  }
  private writeModels(profileId: string, kind: string, models: ModelDefinitionConfig[]): void {
    models.forEach((m, i) => this.db.run("INSERT INTO model_definitions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", profileId,kind,m.id,i,
      m.name ?? null,m.contextWindow ?? null,m.maxTokens ?? null,sqliteBoolean(m.reasoning),sqliteBoolean(m.input?.includes("text")),sqliteBoolean(m.input?.includes("image")),
      optionalJson(m.thinkingLevelMap),optionalJson(m.compat),m.metadataSource ?? null));
  }
  /** Import/upsert one normalized profile; does not erase unrelated accounts. */
  importProfile(p: ModelCredentialProfile, position?: number): void {
    this.db.transaction(tx => {
      const previous = tx.get<any>("SELECT position,revision FROM model_profiles WHERE id=?",p.id);
      const ordinal = position ?? previous?.position ?? tx.get<{n:number}>("SELECT coalesce(max(position)+1,0) AS n FROM model_profiles")!.n;
      tx.run(`INSERT INTO model_profiles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        position=excluded.position,profile_kind=excluded.profile_kind,name=excluded.name,provider_slug=excluded.provider_slug,
        protocol=excluded.protocol,base_url=excluded.base_url,auth_type=excluded.auth_type,oauth_provider_id=excluded.oauth_provider_id,
        request_profile=excluded.request_profile,auth_header=excluded.auth_header,enabled=excluded.enabled,is_default=excluded.is_default,
        created_at=excluded.created_at,updated_at=excluded.updated_at,revision=excluded.revision`,
        p.id,ordinal,p.profileKind ?? null,p.name,p.providerSlug,p.protocol,p.baseUrl ?? null,p.authType,p.oauthProviderId ?? null,p.requestProfile,
        sqliteBoolean(p.authHeader),Number(p.enabled),Number(p.isDefault),p.createdAt,p.updatedAt,this.nextRevision());
      tx.run("INSERT OR REPLACE INTO model_secrets VALUES (?,?,?)",p.id,p.apiKey ?? null,optionalJson(p.oauthCredentials));
      tx.run("DELETE FROM model_headers WHERE profile_id=?",p.id);
      for (const [name,value] of Object.entries(p.headers ?? {})) tx.run("INSERT INTO model_headers VALUES (?,?,?)",p.id,name,value);
      tx.run("DELETE FROM model_definitions WHERE profile_id=?",p.id);
      this.writeModels(p.id,"model",p.models);
      this.writeModels(p.id,"added",p.modelCustomizations?.addedModels ?? []);
      tx.run("DELETE FROM model_customizations WHERE profile_id=?",p.id);
      const disabled = new Set(p.modelCustomizations?.disabled ?? []);
      const overrides = p.modelCustomizations?.contextWindowOverride ?? {};
      for (const id of new Set([...disabled,...Object.keys(overrides)])) tx.run("INSERT INTO model_customizations VALUES (?,?,?,?)",p.id,id,Number(disabled.has(id)),overrides[id] ?? null);
    });
  }
  /** Synchronous service replacement, atomically preserving revisions on unchanged profiles. */
  replace(store: CredentialImport): void {
    this.db.transaction(tx => {
      const previous = this.read().profiles;
      for (const p of previous) if (!store.profiles.some(n => n.id === p.id)) tx.run("DELETE FROM model_profiles WHERE id=?",p.id);
      store.profiles.forEach((p,i) => {
        const old = previous.find(v => v.id === p.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(p)) this.importProfile(p,i);
        else tx.run("UPDATE model_profiles SET position=? WHERE id=?",i,p.id);
      });
      tx.run("DELETE FROM credential_migrations");
      for (const id of store.migrations) tx.run("INSERT INTO credential_migrations VALUES (?)",id);
    });
  }
  /** Return false on edit/delete/recreate while provider IO was in flight. */
  updateSecretIfRevision(id: string, provider: string, revision: number, credential: {apiKey?: string; oauthCredentials?: Record<string, unknown>}, updatedAt: number): boolean {
    return this.db.transaction(tx => {
      const p = this.read().profiles.find(p => p.id === id);
      if (!p || !p.enabled || p.providerSlug !== provider || this.revision(id) !== revision) return false;
      if (credential.oauthCredentials && p.authType !== "oauth" || credential.apiKey && p.authType !== "api_key") return false;
      // Revision increments only; do not replace a whole profile from an old snapshot.
      tx.run("UPDATE model_secrets SET api_key=?,oauth_json=? WHERE profile_id=?",credential.apiKey ?? p.apiKey ?? null,optionalJson(credential.oauthCredentials ?? p.oauthCredentials),id);
      tx.run("UPDATE model_profiles SET revision=?,updated_at=? WHERE id=?",this.nextRevision(),updatedAt,id);
      return true;
    });
  }
}
