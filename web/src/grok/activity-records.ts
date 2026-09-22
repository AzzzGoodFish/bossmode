import type {AgentEvent} from '../components/agent-event-utils';
/** API pages carry durable event payloads, not a front-end sequence number. */
export function mergeActivityEvents(older:AgentEvent[],incoming:AgentEvent[]):AgentEvent[] {
  const unique=new Map<string,AgentEvent>();for(const event of [...older,...incoming])unique.set(JSON.stringify(event),event);
  return [...unique.values()].sort((a,b)=>(a.ts??0)-(b.ts??0));
}
export function activityRecords(events:AgentEvent[]) {
  const starts=new Set(events.filter(e=>e.type==='tool_start').map(e=>e.toolCallId));
  const ends=new Map(events.filter(e=>e.type==='tool_end').map(e=>[e.toolCallId,e]));
  return events.filter(e=>e.type==='tool_start'||e.type==='tool_end'&&!starts.has(e.toolCallId)||e.type.startsWith('context_recovery')||e.type.startsWith('compaction')).map(event=>({event,end:event.type==='tool_start'?ends.get(event.toolCallId):undefined}));
}
const labels:Record<string,string>={chat_send:'发送消息',chat_read:'读取聊天记录',chat_search:'搜索聊天记录',chat_list:'查看聊天列表',chat_info:'查看聊天详情',chat_create:'创建群聊',chat_edit:'修改群聊',member_list:'查看成员列表',member_info:'查看成员资料',profile_read:'读取自己的资料',profile_update:'更新自己的资料',read:'读取文件',write:'写入文件',edit:'修改文件',terminal_exec:'运行命令',terminal_read:'读取命令输出',terminal_wait:'等待命令完成',terminal_create:'打开终端',terminal_list:'查看终端',terminal_close:'关闭终端'};
export function activityLabel(event:AgentEvent):string {
  const args=event.args&&typeof event.args==='object'?event.args as Record<string,unknown>:{};
  if(event.toolName==='bossmode'){if(args.action==='list')return '查看可用能力';if(args.action==='describe')return `查看工具说明 · ${args.tool??''}`;if(args.action==='call')return labels[String(args.tool)]??String(args.tool??'调用工具');}
  if(event.type.startsWith('context_recovery'))return event.type.endsWith('end')?'上下文恢复结果':'恢复上下文';
  if(event.type.startsWith('compaction'))return event.type.endsWith('end')?'压缩结果':'压缩上下文';
  return labels[event.toolName??'']??event.toolName??event.type;
}
