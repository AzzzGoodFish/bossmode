import {expect,it} from 'vitest';
import {activityLabel,activityRecords,mergeActivityEvents,activityRecordKey,activityStatus} from '../../web/src/grok/activity-records';
it('deduplicates repeated pages without requiring seq, pairs tool results, and excludes prompt/turn noise',()=>{
 const events=[{type:'user_prompt',text:'private prompt',ts:1},{type:'agent_start',ts:2},{type:'tool_start',toolName:'chat_send',toolCallId:'a',args:{to:'user'},ts:3},{type:'tool_end',toolName:'chat_send',toolCallId:'a',result:'ok',ts:4},{type:'agent_end',ts:5}];
 const merged=mergeActivityEvents(events,structuredClone(events));expect(merged).toHaveLength(5);const records=activityRecords(merged);expect(records).toHaveLength(1);expect(records[0].end?.result).toBe('ok');expect(activityLabel(records[0].event)).toBe('发送消息');
});
it('retains a missing result as missing and keeps standalone results/boundaries readable',()=>{
 const records=activityRecords([{type:'tool_start',toolCallId:'a',toolName:'read',ts:1},{type:'tool_end',toolCallId:'older',result:'retained',ts:2},{type:'context_recovery_end',ts:3}]);expect(records).toHaveLength(3);expect(records[0].end).toBeUndefined();expect(activityLabel(records[2].event)).toBe('上下文恢复结果');
});
it('keeps reused tool-call IDs in separate runs distinct and pairs their own results',()=>{
 const a={type:'tool_start',toolCallId:'reused',ts:1},b={type:'tool_start',toolCallId:'reused',ts:3};const records=activityRecords([a,{type:'tool_end',toolCallId:'reused',result:'first',ts:2},b,{type:'tool_end',toolCallId:'reused',result:'second',ts:4}]);expect(records).toHaveLength(2);expect(records.map(r=>r.end?.result)).toEqual(['first','second']);expect(activityRecordKey(a)).not.toBe(activityRecordKey(b));
});
it('does not paint success for missing, failed, or aborted work and pairs compaction boundaries',()=>{
 expect(activityStatus({type:'tool_start'}).kind).toBe('missing');expect(activityStatus({type:'tool_start'},{type:'tool_end',isError:true}).kind).toBe('error');expect(activityStatus({type:'compaction_start'},{type:'compaction_end',aborted:true}).kind).toBe('interrupted');
 const records=activityRecords([{type:'compaction_start',ts:1},{type:'compaction_end',result:{summary:'done'},ts:2}]);expect(records).toHaveLength(1);expect(activityStatus(records[0].event,records[0].end).kind).toBe('done');
});
