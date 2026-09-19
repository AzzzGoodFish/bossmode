import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {coreFixture} from "../helpers/core-fixture.js";

let fixture:ReturnType<typeof coreFixture>;
const baseProfile={name:"OpenRouter main",providerSlug:"openrouter",protocol:"openai-responses" as const,baseUrl:"https://openrouter.ai/api/v1",authType:"api_key" as const,apiKey:"sk-secret",requestProfile:"standard" as const,enabled:true,isDefault:true,models:[{id:"anthropic/claude-sonnet",contextWindow:200000,maxTokens:64000,input:["text" as const]}]};
beforeEach(()=>{fixture=coreFixture();});afterEach(()=>{vi.restoreAllMocks();fixture.close();});

describe("model credential profiles",()=>{
  it("validates provider, protocol, secret, and model metadata",async()=>{
    const mod=await import("../../src/config/models.js");
    expect(()=>mod.saveModelCredentialProfile({...baseProfile,providerSlug:"Bad Slug"})).toThrow("Invalid provider slug");
    expect(()=>mod.saveModelCredentialProfile({...baseProfile,protocol:"bad" as any})).toThrow("Unsupported protocol");
    expect(()=>mod.saveModelCredentialProfile({...baseProfile,apiKey:undefined})).toThrow("apiKey is required");
    expect(()=>mod.saveModelCredentialProfile({...baseProfile,models:[{id:"x",contextWindow:0}]})).toThrow("contextWindow");
  });

  it("requires the explicit credential to serve the requested model",async()=>{
    const mod=await import("../../src/config/models.js"),bridge=await import("../../src/config/pi-adapt/credentials.js");
    const saved=mod.saveModelCredentialProfile(baseProfile);
    expect(()=>bridge.exportPiConfigForMember({memberId:"mem_dev",modelRef:"anthropic/claude-sonnet-4-6",credentialId:saved.id})).toThrow("does not include model");
  });

  it("never guesses a profile and resolves an explicit credential id",async()=>{
    const mod=await import("../../src/config/models.js");
    mod.saveModelCredentialProfile(baseProfile);
    const second=mod.saveModelCredentialProfile({...baseProfile,providerSlug:"openrouter-2",isDefault:false,apiKey:"sk-secret-2"});
    expect(mod.resolveCredentialProfileForModel({modelRef:"openrouter/anthropic/claude-sonnet"})).toBeNull();
    expect(mod.resolveCredentialProfileForModel({modelRef:"openrouter/anthropic/claude-sonnet",credentialId:second.id})).toMatchObject({id:second.id,providerSlug:"openrouter-2"});
  });

  it("persists newer OAuth credentials through the SDK credential store",async()=>{
    const mod=await import("../../src/config/models.js"),bridge=await import("../../src/config/pi-adapt/credentials.js");
    const saved=mod.saveModelCredentialProfile({name:"Codex OAuth",providerSlug:"openai-codex",protocol:"openai-codex-responses",baseUrl:"https://chatgpt.com/backend-api",authType:"oauth",oauthProviderId:"openai-codex",oauthCredentials:{access:"profile-access",refresh:"profile-refresh",expires:10},requestProfile:"openai_codex_subscription",enabled:true,isDefault:true,models:[{id:"gpt-5-codex",contextWindow:128000,input:["text"]}]});
    const store=bridge.createCredentialStore(mod.getModelCredentialProfile(saved.id)!);
    await store.modify("openai-codex",async()=>({type:"oauth",access:"new-access",refresh:"new-refresh",expires:999999} as any));
    expect(mod.getModelCredentialProfile(saved.id)!.oauthCredentials).toMatchObject({access:"new-access",refresh:"new-refresh",expires:999999});
  });

  it("includes the current Anthropic and OpenAI model families",async()=>{
    const mod=await import("../../src/config/models.js"),catalog=await import("../../src/config/catalog.js");
    await catalog.ensurePiCatalogWarm();
    const anthropic=mod.connectBuiltinProviderApiKey({providerSlug:"anthropic",apiKey:"sk-ant"});
    expect(anthropic.models.map(model=>model.id)).toContain("claude-fable-5");
    const openai=mod.connectBuiltinProviderApiKey({providerSlug:"openai",apiKey:"sk-openai"});
    for(const id of ["gpt-5.6-luna","gpt-5.6-sol","gpt-5.6-terra"])expect(openai.models.find(model=>model.id===id)).toMatchObject({id,thinkingLevelMap:expect.objectContaining({max:"max"})});
  });
});
