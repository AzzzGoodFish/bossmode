import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, bindDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
import { baseStorageMigration } from "../../src/data/base-schema.js";
import { settingsMigration } from "../../src/data/schema/settings.js";
import { ModelCredentialsRepository } from "../../src/data/repositories/model-settings.js";
import { CatalogRepository } from "../../src/config/pi-adapt/models-store.js";
import type { ModelCredentialProfile } from "../../src/kernel/types.js";
import { saveModelCredentialProfile, getModelCredentialProfile, listPublicModelCredentialProfiles, loadModelCredentialProfiles, normalizeLegacyCredentialImport } from "../../src/config/model-credentials.js";
import { createCredentialStore, exportPiConfigForMember, createDatabaseModelRuntime, refreshDatabaseModelRuntime } from "../../src/config/pi-adapt/runtime-bridge.js";
import { ModelCredentialBinding } from "../../src/engine/runtime/model-credential-binding.js";
import { getCatalog, commitRemoteCatalog, commitProviderOverlays, getProviderOverlays, createDatabaseModelsStore, clearRemoteCatalogMemoryForTests, setPiCatalogModelsForTests } from "../../src/config/model-catalog.js";

let root:string,db:Database,repo:ModelCredentialsRepository;
function open(){db=openDatabase(join(root,"core.sqlite"));applyStorageMigrations(db,[baseStorageMigration,settingsMigration]);bindDatabase(db);repo=new ModelCredentialsRepository(db);}
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"core-settings-credential-"));open();clearRemoteCatalogMemoryForTests();setPiCatalogModelsForTests(null);});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});clearRemoteCatalogMemoryForTests();setPiCatalogModelsForTests(null);});
function profile(id="a",patch:Partial<ModelCredentialProfile>={}):ModelCredentialProfile{return {
  id,profileKind:"custom_endpoint",name:id,providerSlug:"test",protocol:"openai-completions",baseUrl:"https://example.test",authType:"api_key",apiKey:`key-${id}`,requestProfile:"standard",enabled:true,isDefault:true,
  models:[{id:"model",name:"Model",contextWindow:1000,maxTokens:100,reasoning:false,input:["text","image"],thinkingLevelMap:{high:"high"},compat:{custom:true},metadataSource:"endpoint"}],createdAt:10,updatedAt:20,...patch,
};}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

describe("normalized credential repository and fixed-profile SDK adapter",()=>{
  it("round-trips typed profiles with model rows/customizations and secret isolation",()=>{
    const p=profile("a",{headers:{Authorization:"header-secret"},modelCustomizations:{disabled:["model"],contextWindowOverride:{model:900},addedModels:[{id:"added"}]}});
    repo.replace({profiles:[p,profile("b")],migrations:["old-step"]});
    expect(loadModelCredentialProfiles()).toEqual([p,profile("b")]);
    expect(db.all("SELECT id,kind FROM model_definitions WHERE profile_id='a' ORDER BY kind")).toEqual([{id:"added",kind:"added"},{id:"model",kind:"model"}]);
    const publicText=JSON.stringify(listPublicModelCredentialProfiles());expect(publicText).not.toContain("key-a");expect(publicText).not.toContain("header-secret");
    expect(publicText).toContain('"hasSecret":true');
    const revision=repo.revision("a");loadModelCredentialProfiles();expect(repo.revision("a")).toBe(revision);
    db.close();open();expect(repo.read()).toEqual({profiles:[p,profile("b")],migrations:["old-step"]});
  });
  it("preserves hidden custom headers when saving the redacted public profile",()=>{
    repo.importProfile(profile("a",{headers:{Authorization:"header-secret"}}));
    const publicProfile=listPublicModelCredentialProfiles()[0];
    expect(publicProfile.headers).toBeUndefined();
    saveModelCredentialProfile({...publicProfile,name:"renamed"});
    expect(getModelCredentialProfile("a")?.headers).toEqual({Authorization:"header-secret"});
  });
  it("checks revisions against independent connections without holding a transaction across provider IO",()=>{
    repo.importProfile(profile());const revision=repo.revision("a")!;
    const other=openDatabase(db.path);
    try {new ModelCredentialsRepository(other).importProfile(profile("a",{apiKey:"other-writer"}));} finally {other.close();}
    expect(repo.updateSecretIfRevision("a","test",revision,{apiKey:"stale"},30)).toBe(false);
    expect(getModelCredentialProfile("a")?.apiKey).toBe("other-writer");
  });
  it("rolls back profile/secret/model updates together on invalid opaque JSON",()=>{
    repo.importProfile(profile());const revision=repo.revision("a");
    expect(()=>repo.importProfile(profile("a",{name:"changed",oauthCredentials:[] as any}))).toThrow("JSON object");
    expect(repo.read().profiles[0]).toEqual(profile());expect(repo.revision("a")).toBe(revision);
  });
  it("does not migrate on get; explicit pure importer normalization preserves the original object",()=>{
    const p=profile("a",{models:[{id:"model",input:["text"]}],requestProfile:"anthropic_claude_code_oauth" as any});
    repo.replace({profiles:[p],migrations:[]});const revision=repo.revision("a");
    expect(loadModelCredentialProfiles()[0]).toEqual(p);expect(repo.revision("a")).toBe(revision);
    const normalized=normalizeLegacyCredentialImport({profiles:[p],migrations:[]},[]);
    expect(normalized.profiles[0].requestProfile).toBe("standard");expect(normalized.profiles[0].models[0].reasoning).toBe(true);
    expect(p.models[0].reasoning).toBeUndefined();expect(repo.revision("a")).toBe(revision);
  });
  it("preserves binding across awaits and account switches without touching the binding implementation",async()=>{
    repo.replace({profiles:[profile("a"),profile("b")],migrations:[]});
    const binding=new ModelCredentialBinding({id:"a",providerSlug:"test"});
    const a=binding.bind({id:"model"},{id:"a",providerSlug:"test"});
    const b=binding.bind({id:"model"},{id:"b",providerSlug:"test"});
    let current=a;binding.followSession(()=>current);
    const entered=deferred(),release=deferred();
    const pending=binding.run(a,()=>binding.modify("test",async credential=>{entered.resolve();await release.promise;expect(credential).toEqual({type:"api_key",key:"key-a"});return {type:"api_key",key:"rotated-a"};}));
    await entered.promise;current=b;expect(await binding.read("test")).toEqual({type:"api_key",key:"key-b"});release.resolve();await pending;
    expect(getModelCredentialProfile("a")?.apiKey).toBe("rotated-a");expect(getModelCredentialProfile("b")?.apiKey).toBe("key-b");
  });
  it.each(["edit","delete","recreate"])("rejects stale refresh after concurrent %s",async action=>{
    repo.importProfile(profile("a",{authType:"oauth",apiKey:undefined,oauthCredentials:{access:"old",refresh:"r",expires:1}}));
    const store=createCredentialStore({id:"a",providerSlug:"test"});const entered=deferred(),release=deferred();
    const pending=store.modify("test",async()=>{entered.resolve();await release.promise;return {type:"oauth",access:"stale",refresh:"stale-r",expires:9999};});
    await entered.promise;
    if(action === "delete" || action === "recreate")repo.replace({profiles:[],migrations:[]});
    if(action !== "delete")repo.importProfile(profile("a",{authType:"oauth",apiKey:undefined,oauthCredentials:{access:"new",refresh:"new-r",expires:2}}));
    release.resolve();const returned=await pending;
    expect(getModelCredentialProfile("a")?.oauthCredentials?.access).toBe(action === "delete" ? undefined : "new");
    expect((returned as any)?.access).toBe(action === "delete" ? undefined : "new");
  });
  it("does not replace a newer OAuth token with an older-expiry callback result",async()=>{
    repo.importProfile(profile("a",{authType:"oauth",apiKey:undefined,oauthCredentials:{access:"new",refresh:"r",expires:100}}));
    const store=createCredentialStore({id:"a",providerSlug:"test"});
    const returned=await store.modify("test",async()=>({type:"oauth",access:"old",refresh:"r-old",expires:50}));
    expect((returned as any).access).toBe("new");expect(getModelCredentialProfile("a")?.oauthCredentials?.access).toBe("new");
  });
  it("serializes same-profile refreshes and releases the queue after failure",async()=>{
    repo.importProfile(profile());const store=createCredentialStore({id:"a",providerSlug:"test"});
    const entered=deferred(),release=deferred();
    const first=store.modify("test",async()=>{entered.resolve();await release.promise;throw new Error("provider failed");});
    await entered.promise;
    let called=false;const second=store.modify("test",async current=>{called=true;return current;});
    await Promise.resolve();expect(called).toBe(false);release.resolve();await expect(first).rejects.toThrow("provider failed");await second;expect(called).toBe(true);
  });
  it("constructs and refreshes the real SDK runtime using only native DB adapters",async()=>{
    repo.importProfile(profile());
    const binding=new ModelCredentialBinding({id:"a",providerSlug:"test"});
    const runtime=await createDatabaseModelRuntime(binding,"a");
    binding.attach(runtime);
    const first=runtime.getModel("test","model")!;
    expect(first.contextWindow).toBe(1000);
    const bound=binding.bind(first,{id:"a",providerSlug:"test"});
    const auth=await runtime.getAuth(bound);expect(auth).toMatchObject({auth:{apiKey:"key-a"}});
    repo.importProfile(profile("a",{models:[{id:"model",contextWindow:2000}]}));
    await refreshDatabaseModelRuntime(runtime,"a");expect(runtime.getModel("test","model")?.contextWindow).toBe(2000);
  });
  it("retains SDK agentDir semantics without generating models/auth file authority",()=>{
    repo.importProfile(profile());
    const exported=exportPiConfigForMember({roomId:"room",memberName:"settings-member",modelRef:"test/model",credentialId:"a"})!;
    expect(exported.agentDir).toContain("pi-agent/runtime/room/settings-member");
    expect(existsSync(join(exported.agentDir,"models.json"))).toBe(false);
    expect(existsSync(join(exported.agentDir,"auth.json"))).toBe(false);
  });
});

describe("database catalog and native ModelsStore",()=>{
  const models=[{provider:"test",id:"one",name:"One",api:"openai-completions",baseUrl:"https://example.test",contextWindow:100,maxTokens:50,reasoning:true,input:["text"],cost:{input:1,output:2,cacheRead:0,cacheWrite:0},compat:{foo:"bar"}}];
  it("persists normalized model identities with SDK-specific metadata and rejects stale refresh",()=>{
    commitRemoteCatalog(models,100);commitRemoteCatalog([{...models[0],id:"stale"}],50);
    expect(getCatalog()).toMatchObject({models,source:"remote",fetchedAt:100});
    expect(db.get<any>("SELECT provider,id,context_window FROM catalog_models WHERE snapshot_id='remote'")).toEqual({provider:"test",id:"one",context_window:100});
    db.close();open();expect(getCatalog().models).toEqual(models);
    expect(()=>new CatalogRepository(db).importRemote({models:[{invalid:true}],fetchedAt:200,updatedAt:""})).toThrow("identity");
    expect(getCatalog().models).toEqual(models);
  });
  it("supplies Pi's supported ModelsStore interface without a file adapter",async()=>{
    commitProviderOverlays({test:{models,lastModified:100,checkedAt:200,etag:'"etag"'}});
    const adapter=createDatabaseModelsStore();expect(await adapter.read("test")).toEqual(getProviderOverlays().test);
    await adapter.write("test",{models:[] as any,checkedAt:50});expect((await adapter.read("test"))?.models).toEqual(models);
    db.close();open();expect(getProviderOverlays().test.etag).toBe('"etag"');
    await createDatabaseModelsStore().delete("test");expect(await createDatabaseModelsStore().read("test")).toBeUndefined();
  });
  it("propagates unavailable storage instead of accepting only an in-memory change",()=>{
    commitRemoteCatalog(models,100);db.exec("PRAGMA query_only=ON");
    expect(()=>commitRemoteCatalog([{...models[0],id:"new"}],200)).toThrow();expect(getCatalog().models).toEqual(models);
    db.close();expect(()=>getCatalog()).toThrow("bootstrap");
  });
});
