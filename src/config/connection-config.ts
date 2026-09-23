export type ConnectionRoute='key'|'service'|'aws-token'|'aws-profile'|'aws-chain'|'vertex-key'|'vertex-adc'|'vertex-file';
export interface ConnectionSettings {account?:string;gateway?:string;azureMode?:'url'|'resource';baseUrl?:string;resource?:string;apiVersion?:string;mappings?:Array<{model:string;deployment:string}>;profile?:string;project?:string;location?:string;path?:string;}
export interface ProviderConnection {route:ConnectionRoute;settings:ConnectionSettings;}
const ENV_KEYS:Record<string,string[]>={
 'amazon-bedrock':['AWS_PROFILE'],
 'google-vertex':['GOOGLE_CLOUD_PROJECT','GOOGLE_CLOUD_LOCATION','GOOGLE_APPLICATION_CREDENTIALS'],
 'cloudflare-workers-ai':['CLOUDFLARE_ACCOUNT_ID'],
 'cloudflare-ai-gateway':['CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_GATEWAY_ID'],
 'azure-openai-responses':['AZURE_OPENAI_BASE_URL','AZURE_OPENAI_RESOURCE_NAME','AZURE_OPENAI_API_VERSION','AZURE_OPENAI_DEPLOYMENT_NAME_MAP'],
};
export function validateCredentialEnv(provider:string,value:unknown):Record<string,string>|undefined {
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid provider credential environment');
 const env:Record<string,string>={};for(const [key,item] of Object.entries(value)){if(!ENV_KEYS[provider]?.includes(key)||typeof item!=='string'||!item.trim()||/[\r\n\0]/.test(item))throw Error('Unsupported provider credential setting');env[key]=item.trim();}return Object.keys(env).length?env:undefined;
}
export function normalizeConnection(provider:string,value:ProviderConnection):ProviderConnection {
 if(!value||typeof value!=='object'||!value.settings||typeof value.settings!=='object'||Array.isArray(value.settings))throw Error('Invalid connection settings');
 const routes:ConnectionRoute[]=provider==='amazon-bedrock'?['aws-token','aws-profile','aws-chain']:provider==='google-vertex'?['vertex-key','vertex-adc','vertex-file']:provider in ENV_KEYS?['service']:['key'];
 if(!routes.includes(value.route))throw Error('Unsupported authentication route for this provider');
 const allowed=provider==='amazon-bedrock'?['profile']:provider==='google-vertex'?['project','location','path']:provider==='azure-openai-responses'?['azureMode','baseUrl','resource','apiVersion','mappings']:provider==='cloudflare-ai-gateway'?['account','gateway']:provider==='cloudflare-workers-ai'?['account']:[];
 const settings:ConnectionSettings={};for(const [key,item] of Object.entries(value.settings)){if(!allowed.includes(key))throw Error(`Unsupported connection field: ${key}`);if(key==='mappings')continue;if(typeof item!=='string'||/[\x00-\x1f\x7f]/.test(item))throw Error(`Invalid connection field: ${key}`);if(item.trim())(settings as Record<string,unknown>)[key]=item.trim();}
 const required=(key:keyof ConnectionSettings,label:string)=>{if(!settings[key])throw Error(`请填写${label}。`);};
 if(value.route==='aws-profile')required('profile',' AWS profile');
 if(['vertex-adc','vertex-file'].includes(value.route)){required('project','项目 ID');required('location','地区');if(value.route==='vertex-file')required('path','服务端凭证文件路径');}
 if(provider.startsWith('cloudflare-')){required('account','账号 ID');if(!/^[a-zA-Z0-9_-]+$/.test(settings.account!))throw Error('账号 ID 不能包含空格或路径分隔符。');if(provider==='cloudflare-ai-gateway'){required('gateway','网关 ID');if(!/^[a-zA-Z0-9._-]+$/.test(settings.gateway!))throw Error('网关 ID 格式不正确。');}}
 if(provider==='azure-openai-responses'){
  settings.azureMode??='url';if(!['url','resource'].includes(settings.azureMode))throw Error('Invalid Azure address mode');
  if(settings.azureMode==='resource'){required('resource','资源名');if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(settings.resource!))throw Error('资源名只能包含字母、数字和连字符。');delete settings.baseUrl;}
  else {required('baseUrl','基础 URL');try{const url=new URL(settings.baseUrl!);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/\s/.test(settings.baseUrl!))throw Error();}catch{throw Error('请填写有效的基础 URL，不含账号、密码或查询参数。');}delete settings.resource;}
  const raw=value.settings.mappings??[];if(!Array.isArray(raw))throw Error('Invalid deployment mappings');const seen=new Set<string>();settings.mappings=raw.map(item=>{if(!item||typeof item.model!=='string'||typeof item.deployment!=='string'||!item.model.trim()||!item.deployment.trim()||/[\r\n,=\0]/.test(item.model+item.deployment)||seen.has(item.model.trim()))throw Error('部署映射需填写唯一模型 ID 和有效部署名。');seen.add(item.model.trim());return {model:item.model.trim(),deployment:item.deployment.trim()};});
 }
 return {route:value.route,settings};
}
export function azureCredentialEnv(connection:ProviderConnection):Record<string,string> {
 const s=connection.settings;return {...(s.azureMode==='resource'?{AZURE_OPENAI_RESOURCE_NAME:s.resource!}:{AZURE_OPENAI_BASE_URL:s.baseUrl!}),...(s.apiVersion?{AZURE_OPENAI_API_VERSION:s.apiVersion}:{}),...(s.mappings?.length?{AZURE_OPENAI_DEPLOYMENT_NAME_MAP:s.mappings.map(m=>`${m.model}=${m.deployment}`).join(',')}:{})};
}
export function cloudCredentialConfigured(provider:string,connection?:ProviderConnection,env?:Record<string,string>):boolean {
 if(provider==='amazon-bedrock')return connection?.route==='aws-chain'||connection?.route==='aws-profile'&&!!env?.AWS_PROFILE;
 return provider==='google-vertex'&&['vertex-adc','vertex-file'].includes(connection?.route??'')&&!!env?.GOOGLE_CLOUD_PROJECT&&!!env?.GOOGLE_CLOUD_LOCATION&&(connection?.route!=='vertex-file'||!!env.GOOGLE_APPLICATION_CREDENTIALS);
}
