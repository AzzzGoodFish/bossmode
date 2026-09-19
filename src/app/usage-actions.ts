import {aggregateUsageRows,readUsageRows,type UsageRow,type UsageSeriesPoint,type UsageTotals} from "../agent/events.js";
import {getRoom,listRooms} from "../chat/conversations.js";
import {getRetainedMember} from "../member/identity.js";

export interface UsageReportQuery {from?:string;to?:string;member?:string;agent?:string;model?:string}
export interface UsageBreakdown extends UsageTotals {memberId:string;memberName?:string;agent?:string;model:string}
export interface UsageAgentBucket extends UsageTotals {agent:string}
export interface UsageRoomBucket extends UsageTotals {roomId:string;roomName?:string}
export interface UsageReport {
  kpis:UsageTotals&{cacheHitRate:number};
  series:Array<Omit<UsageSeriesPoint,"byMember">&{byAgent:Record<string,number>}>;
  breakdown:UsageBreakdown[];byAgent:UsageAgentBucket[];
}
export interface PlatformUsageReport extends UsageReport {byRoom:UsageRoomBucket[]}

type MemberMeta={name:string;agent:string};
function metadata(rows:UsageRow[]):Map<string,MemberMeta>{
  const result=new Map<string,MemberMeta>();
  for(const id of new Set(rows.flatMap(row=>row.memberId?[row.memberId]:[]))){
    const member=getRetainedMember(id);if(member)result.set(id,{name:member.name,agent:member.agentTemplate});
  }
  return result;
}
function filtered(rows:UsageRow[],query:UsageReportQuery,meta:Map<string,MemberMeta>):UsageRow[]{
  return rows.filter(row=>(!query.member||row.memberId===query.member)
    &&(!query.model||row.model===query.model)
    &&(!query.agent||(row.memberId!==null&&meta.get(row.memberId)?.agent===query.agent)));
}
function add(target:UsageTotals,row:UsageTotals):void{
  target.inputTokens+=row.inputTokens;target.outputTokens+=row.outputTokens;
  target.cacheRead+=row.cacheRead;target.cacheWrite+=row.cacheWrite;target.cost+=row.cost;target.turns+=row.turns;
}
function empty():UsageTotals{return {inputTokens:0,outputTokens:0,cacheRead:0,cacheWrite:0,cost:0,turns:0};}
function eachDay(from:string,to:string):string[]{
  const dates:string[]=[],day=new Date(`${from}T00:00:00Z`),end=new Date(`${to}T00:00:00Z`);
  for(let count=0;day<=end&&count<400;count++,day.setUTCDate(day.getUTCDate()+1))dates.push(day.toISOString().slice(0,10));
  return dates;
}
function fillGaps(series:UsageReport["series"],from?:string,to?:string):UsageReport["series"]{
  const dates=series.map(point=>point.date).sort(),start=from||dates[0]||new Date().toISOString().slice(0,10),end=to||new Date().toISOString().slice(0,10);
  if(start>end)return series;
  const existing=new Map(series.map(point=>[point.date,point]));
  return eachDay(start,end).map(date=>existing.get(date)??{date,cost:0,inputTokens:0,outputTokens:0,cacheRead:0,byModel:{},byAgent:{}});
}
function report(rows:UsageRow[],meta:Map<string,MemberMeta>,query:UsageReportQuery):UsageReport{
  const aggregate=aggregateUsageRows(rows),agentGroups=new Map<string,UsageAgentBucket>();
  for(const member of aggregate.byMember){
    const agent=meta.get(member.memberId)?.agent||member.memberId,bucket=agentGroups.get(agent)??{...empty(),agent};
    agentGroups.set(agent,bucket);add(bucket,member);
  }
  const series=aggregate.series.map(({byMember,...point})=>{
    const byAgent:Record<string,number>={};
    for(const [memberId,tokens] of Object.entries(byMember)){
      const agent=meta.get(memberId)?.agent||memberId;byAgent[agent]=(byAgent[agent]||0)+tokens;
    }
    return {...point,byAgent};
  });
  return {
    kpis:aggregate.kpis,series:fillGaps(series,query.from,query.to),
    breakdown:aggregate.byMemberModel.map(row=>({...row,memberName:meta.get(row.memberId)?.name,agent:meta.get(row.memberId)?.agent})),
    byAgent:[...agentGroups.values()].sort((a,b)=>b.inputTokens-a.inputTokens),
  };
}
function read(query:UsageReportQuery,sourceRef?:string):{rows:UsageRow[];meta:Map<string,MemberMeta>}{
  const rows=readUsageRows({from:query.from,to:query.to,sourceRef}),meta=metadata(rows);
  return {rows:filtered(rows,query,meta),meta};
}
export function getRoomUsageReport(roomId:string,query:UsageReportQuery={}):UsageReport|null{
  if(!getRoom(roomId))return null;
  const {rows,meta}=read(query,`room:${roomId}`);return report(rows,meta,query);
}
export function getPlatformUsageReport(query:UsageReportQuery={}):PlatformUsageReport{
  const {rows,meta}=read(query),names=new Map(listRooms().map(room=>[room.id,room.name])),groups=new Map<string,UsageRoomBucket>();
  for(const row of rows){
    const roomId=row.sourceRef?.startsWith("room:")?row.sourceRef.slice(5):row.sourceRef||row.historicalSourceKey||"historical-unattributed";
    const bucket=groups.get(roomId)??{...empty(),roomId,roomName:names.get(roomId)};groups.set(roomId,bucket);add(bucket,row);
  }
  return {...report(rows,meta,query),byRoom:[...groups.values()].sort((a,b)=>b.inputTokens-a.inputTokens)};
}
