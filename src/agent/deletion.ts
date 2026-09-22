import type {Database} from '../data/database.js';
/** Only after member admission is closed and all its executions have settled. */
export function purgeMemberAgentData(memberId:string,db:Database):void {
  for(const table of ['queued_inputs','execution_attempts','agent_events','runtime_stale_fields','runtime_checkpoints','member_statistics','token_usage_daily']) {
    db.run(`DELETE FROM ${table} WHERE member_id=?`,memberId);
  }
}
