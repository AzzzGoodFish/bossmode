import {getUsername} from '../api/client';
import type {AgentEvent} from '../components/agent-event-utils';
const accountKey=(key:string)=>`${getUsername()??''}:${key}`;
export interface WorkspaceView {workspace:string;paths:Map<string,string>;positions:Map<string,number>}
export interface ActivityView {events:AgentEvent[];before?:number;hasMore:boolean;query:string;find:boolean;openId:string|null;scroll:number;baseScroll:number;blocks:Map<string,{top:number;left:number}>}
const workspaceViews=new Map<string,WorkspaceView>(),activityViews=new Map<string,ActivityView>(),members=new Map<string,string>();
function bounded<T>(map:Map<string,T>,key:string,create:()=>T,limit:number):T {let value=map.get(key);map.delete(key);if(!value)value=create();map.set(key,value);while(map.size>limit)map.delete(map.keys().next().value!);return value;}
export function workspaceView(id:string):WorkspaceView {return bounded(workspaceViews,accountKey(id),()=>({workspace:'',paths:new Map(),positions:new Map()}),40);}
export function activityView(id:string,scope:string):ActivityView {return bounded(activityViews,accountKey(`${id}:${scope}`),()=>({events:[],hasMore:false,query:'',find:false,openId:null,scroll:0,baseScroll:0,blocks:new Map()}),4);}
export function panelMember(scope:string,kind:string):string{return members.get(accountKey(`${scope}:${kind}`))??'';}
export function setPanelMember(scope:string,kind:string,id:string):void{members.set(accountKey(`${scope}:${kind}`),id);}
export function forgetMemberPaneState(id:string):void {workspaceViews.delete(accountKey(id));for(const key of activityViews.keys())if(key.startsWith(accountKey(id)+':'))activityViews.delete(key);for(const [key,value] of members)if(value===id)members.delete(key);}
export function forgetScopePaneState(scope:string):void {for(const key of members.keys())if(key.startsWith(accountKey(scope)+':'))members.delete(key);for(const key of activityViews.keys())if(key.endsWith(':'+scope))activityViews.delete(key);}
const usageViews=new Map<string,{preset:string;from:string;to:string}>();
export function usageView(){return bounded(usageViews,accountKey('usage'),()=>({preset:'30',from:new Date(Date.now()-29*86400000).toISOString().slice(0,10),to:new Date().toISOString().slice(0,10)}),4);}
export function clearPaneState():void {workspaceViews.clear();activityViews.clear();members.clear();usageViews.clear();}
