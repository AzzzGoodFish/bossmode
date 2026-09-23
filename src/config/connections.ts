import {getDatabase} from '../data/database.js';
import {getBuiltinProvider,modelsForBuiltinProvider,protocolForBuiltinProvider,baseUrlForBuiltinProvider} from './catalog.js';
import {getModelCredentialProfile,saveModelCredentialProfile,nextBuiltinProfileName,credentialRevision} from './models.js';
import {normalizeConnection,validateCredentialEnv,type ProviderConnection} from './connection-config.js';
import {loginProviderApiKey,createDatabaseModelRuntime,createCredentialStore} from './pi-adapt/credentials.js';
export async function refreshProviderModels(profileId:string,signal:AbortSignal=AbortSignal.timeout(15000)) {
 const profile=getModelCredentialProfile(profileId);if(!profile||profile.profileKind!=='builtin_provider')throw Error('内置供应商接入不存在。');
 const revision=credentialRevision(profile.id,getDatabase());
 const runtime=await createDatabaseModelRuntime(createCredentialStore(profile),profile.id);
 const result=await runtime.refresh({providers:[profile.providerSlug],allowNetwork:true,signal});
 signal.throwIfAborted();if(result.errors.size)throw Error('模型目录更新失败，请检查供应商连接后重试。');
 const models=runtime.getModels(profile.providerSlug).map(model=>({id:model.id,name:model.name,contextWindow:model.contextWindow,maxTokens:model.maxTokens,reasoning:model.reasoning,input:model.input,thinkingLevelMap:model.thinkingLevelMap,compat:model.compat as Record<string,unknown>|undefined,cost:model.cost,metadataSource:'pi_catalog' as const}));
 return getDatabase().transaction(()=>{if(credentialRevision(profile.id,getDatabase())!==revision)throw Error('接入在更新期间已改变，请刷新后重试。');return saveModelCredentialProfile({...profile,models});});
}

export interface ConnectProviderInput {providerSlug:string;profileId?:string;name?:string;apiKey?:string;connection:ProviderConnection;}
export async function connectProvider(input:ConnectProviderInput,signal:AbortSignal=AbortSignal.timeout(15000)) {
 if(!input||typeof input!=='object'||typeof input.providerSlug!=='string')throw Error('Invalid provider request');
 const provider=getBuiltinProvider(input.providerSlug);
 if(!provider?.authModes.includes('api_key'))throw Error('供应商不支持此接入方式。');
 const existing=input.profileId?getModelCredentialProfile(input.profileId):null;
 if(input.profileId&&!existing)throw Error('接入已被移除，请重新添加。');
 if(existing&&existing.providerSlug!==input.providerSlug)throw Error('接入与供应商不一致。');
 const revision=existing?credentialRevision(existing.id,getDatabase()):null;
 const connection=normalizeConnection(input.providerSlug,input.connection);
 const credential=await loginProviderApiKey(input.providerSlug,input.apiKey?.trim()||existing?.apiKey,connection,signal);
 signal.throwIfAborted();
 const credentialEnv=validateCredentialEnv(input.providerSlug,credential.env);
 return getDatabase().transaction(()=>{
  if(existing&&credentialRevision(existing.id,getDatabase())!==revision)throw Error('接入在保存期间已改变，请刷新后重试。');
  return saveModelCredentialProfile({
   ...existing,id:existing?.id,profileKind:'builtin_provider',providerSlug:input.providerSlug,
   name:input.name?.trim()||existing?.name||nextBuiltinProfileName(input.providerSlug,provider.displayName),
   protocol:protocolForBuiltinProvider(input.providerSlug),baseUrl:baseUrlForBuiltinProvider(input.providerSlug),
   authType:'api_key',apiKey:credential.apiKey,connection,credentialEnv,oauthCredentials:undefined,oauthProviderId:undefined,
   requestProfile:'standard',enabled:existing?.enabled??true,isDefault:existing?.isDefault??false,
   models:existing?.models??modelsForBuiltinProvider(input.providerSlug),
  },{replaceApiKey:true});
 });
}
