import type {ModelDefinitionConfig,ModelProtocol,PublicModelCredentialProfile} from '../api/client';

export const endpointProtocols:ModelProtocol[]=['openai-completions','openai-responses','anthropic-messages','google-generative-ai'];
export const thinkingFormats=['openai','openrouter','deepseek','together','baseten','zai','qwen','chat-template','qwen-chat-template','string-thinking','ant-ling'];
export const thinkingLevels=['off','minimal','low','medium','high','xhigh','max'] as const;
export const priceKeys=['input','output','cacheRead','cacheWrite'] as const;
export type PriceKey=typeof priceKeys[number];
export type ModelPrices=Partial<Record<PriceKey,number>>;
export type PricedModel=ModelDefinitionConfig&{cost?:ModelPrices};
export interface HeaderDraft {name:string;value:string;stored?:boolean}
export interface EndpointDraft {
 url:string;key:string;modelId:string;displayName:string;protocol:ModelProtocol;context:string;output:string;
 reasoning:boolean;images:boolean;format:string;prices:Record<PriceKey,string>;
 levels:Record<typeof thinkingLevels[number],{mode:'inherit'|'unsupported'|'value';value:string}>;
 headers:HeaderDraft[];
}
export class FormError extends Error {constructor(readonly field:string,message:string){super(message);}}
export function endpointDraft(profile?:PublicModelCredentialProfile,index=0):EndpointDraft {
 const model:PricedModel|undefined=profile?.models[index];
 return {url:profile?.baseUrl??'',key:'',modelId:model?.id??'',displayName:model?.name??'',protocol:profile?.protocol??'openai-completions',context:model?.contextWindow?.toString()??'',output:model?.maxTokens?.toString()??'',reasoning:model?.reasoning??false,images:model?.input?.includes('image')??false,format:String(model?.compat?.thinkingFormat??''),prices:Object.fromEntries(priceKeys.map(key=>[key,model?.cost?.[key]?.toString()??''])) as EndpointDraft['prices'],levels:Object.fromEntries(thinkingLevels.map(level=>{const value=model?.thinkingLevelMap?.[level];return [level,{mode:value===null?'unsupported':value===undefined?'inherit':'value',value:value??''}];})) as EndpointDraft['levels'],headers:(profile?.headerNames??[]).map(name=>({name,value:'',stored:true}))};
}
export function validateEndpointUrl(value:string,field='maEpUrl'):string {
 const text=value.trim();try{const url=new URL(text);if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash||/[\x00-\x20\x7f]/.test(text))throw Error();}catch{throw new FormError(field,'请填写有效的 HTTP 或 HTTPS 地址，不含账号、密码或查询参数。');}return text;
}
export function serializeEndpoint(draft:EndpointDraft,previous?:PricedModel):PricedModel {
 validateEndpointUrl(draft.url);
 const id=draft.modelId.trim();if(!id||/[\x00-\x1f\x7f]/.test(id))throw new FormError('maEpModel','请填写模型名，不包含换行或控制字符。');
 const integer=(value:string,field:string,label:string)=>{if(!value.trim())return undefined;if(!/^[1-9]\d*$/.test(value.trim())||!Number.isSafeInteger(Number(value)))throw new FormError(field,`${label}需为正整数，未知时可以留空。`);return Number(value);};
 const contextWindow=integer(draft.context,'maEpContext','上下文窗口'),maxTokens=integer(draft.output,'maEpOutput','最大输出');
 const cost:ModelPrices={};for(const key of priceKeys){const value=draft.prices[key].trim();if(!value)continue;if(!/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)||!Number.isFinite(Number(value)))throw new FormError(`maEpPrice-${key}`,'价格需为非负数；留空表示未知，0 表示免费。');cost[key]=Number(value);}
 const thinkingLevelMap:ModelDefinitionConfig['thinkingLevelMap']={};if(draft.reasoning)for(const level of thinkingLevels){const item=draft.levels[level];if(item.mode==='unsupported')thinkingLevelMap[level]=null;else if(item.mode==='value'){if(!item.value.trim()||/[\x00-\x1f\x7f]/.test(item.value))throw new FormError(`maEpValue-${level}`,`请填写 ${level} 对应的值，或选择继承／不支持。`);thinkingLevelMap[level]=item.value.trim();}}
 const compat={...previous?.compat};delete compat.thinkingFormat;if(draft.reasoning&&draft.protocol==='openai-completions'&&draft.format){if(!thinkingFormats.includes(draft.format))throw new FormError('maEpFormat','请选择支持的思考格式。');compat.thinkingFormat=draft.format;}
 return {...previous,id,name:draft.displayName.trim()||id,contextWindow,maxTokens,reasoning:draft.reasoning,input:draft.images?['text','image']:['text'],thinkingLevelMap:Object.keys(thinkingLevelMap).length?thinkingLevelMap:undefined,compat:Object.keys(compat).length?compat:undefined,cost:Object.keys(cost).length?cost:undefined,metadataSource:'endpoint'};
}
export function validateHeaderDrafts(headers:HeaderDraft[]):void {
 const names=new Set<string>();headers.forEach((header,index)=>{const name=header.name.trim();if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))throw new FormError(`maEpHeader-${index}`,'请填写有效的请求头名称，或移除此行。');if(names.has(name.toLowerCase()))throw new FormError(`maEpHeader-${index}`,'请求头名称重复，请合并或移除重复项。');names.add(name.toLowerCase());if(/[\r\n\0]/.test(header.value))throw new FormError(`maEpHeaderValue-${index}`,'请求头值不能包含换行或空字符。');if(!header.stored&&!header.value)throw new FormError(`maEpHeaderValue-${index}`,'请填写请求头值，或移除此行。');});
}
