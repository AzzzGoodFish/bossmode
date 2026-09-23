import type {AgentEvent} from '../components/agent-event-utils';
/** API pages carry durable event payloads, not a front-end sequence number. */
export function mergeActivityEvents(older:AgentEvent[],incoming:AgentEvent[]):AgentEvent[] {
  const unique=new Map<string,AgentEvent>();for(const event of [...older,...incoming])unique.set(JSON.stringify(event),event);
  return [...unique.values()].sort((a,b)=>(a.ts??0)-(b.ts??0));
}
export function activityRecords(events:AgentEvent[]) {
  const ends=new Map<AgentEvent,AgentEvent>(),pending=new Map<string,AgentEvent>(),paired=new Set<AgentEvent>();
  for(const event of events){const kind=event.type.startsWith('tool_')&&event.toolCallId?`tool:${String(event.sessionId??'')}:${event.toolCallId}`:event.type.startsWith('context_recovery')?'context_recovery':event.type.startsWith('compaction')?'compaction':'';if(!kind)continue;if(event.type.endsWith('_start'))pending.set(kind,event);else if(event.type.endsWith('_end')){let start=pending.get(kind),pendingKey=kind;if(!start&&kind.startsWith('tool:')){const candidates=[...pending].filter(([,value])=>value.toolCallId===event.toolCallId);if(candidates.length===1){[pendingKey,start]=candidates[0];}}if(start){ends.set(start,event);paired.add(event);pending.delete(pendingKey);}}}
  return events.filter(e=>(e.type==='tool_start'||e.type==='tool_end'||e.type.startsWith('context_recovery')||e.type.startsWith('compaction'))&&!paired.has(e)).map(event=>({event,end:ends.get(event)}));
}
export function activityRecordKey(event:AgentEvent):string{return `${event.type}:${String(event.sessionId??'')}:${String(event.toolCallId??'')}:${String(event.seq??event.ts??JSON.stringify(event))}:${event.toolName??''}`;}
export function activityStatus(event:AgentEvent,end?:AgentEvent):{label:string;kind:'done'|'error'|'interrupted'|'missing'} {
 const result=end??event;
 if(result.aborted===true||result.cancelled===true)return {label:'已中断',kind:'interrupted'};
 if(result.isError||result.errorMessage)return {label:'失败',kind:'error'};
 if(event.type.endsWith('_start')&&!end)return {label:'未收到结果',kind:'missing'};
 if(result.type==='tool_end'||result.result!==undefined)return {label:'已完成',kind:'done'};
 return {label:'未收到结果',kind:'missing'};
}
const labels:Record<string,string>={chat_send:'发送消息',chat_read:'读取聊天记录',chat_search:'搜索聊天记录',chat_list:'查看聊天列表',chat_info:'查看聊天详情',chat_create:'创建群聊',chat_edit:'修改群聊',member_list:'查看成员列表',member_info:'查看成员资料',profile_read:'读取自己的资料',profile_update:'更新自己的资料',read:'读取文件',write:'写入文件',edit:'修改文件',terminal_exec:'运行命令',terminal_read:'读取命令输出',terminal_wait:'等待命令完成',terminal_create:'打开终端',terminal_list:'查看终端',terminal_close:'关闭终端'};
export function activityLabel(event:AgentEvent):string {
  const args=event.args&&typeof event.args==='object'?event.args as Record<string,unknown>:{};
  if(event.toolName==='bossmode'){if(args.action==='list')return '查看可用能力';if(args.action==='describe')return `查看工具说明 · ${args.tool??''}`;if(args.action==='call')return labels[String(args.tool)]??String(args.tool??'调用工具');}
  if(event.type.startsWith('context_recovery'))return event.type.endsWith('end')?'上下文恢复结果':'恢复上下文';
  if(event.type.startsWith('compaction'))return event.type.endsWith('end')?'压缩结果':'压缩上下文';
  return labels[event.toolName??'']??event.toolName??event.type;
}
