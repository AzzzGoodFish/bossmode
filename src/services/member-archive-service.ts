import { getDatabase } from "../data/database.js";
import { getBossmodeDir } from "../shared/config.js";
import { MemberArchiveService } from "../workspace/member-archive-lifecycle.js";
import { quiesceMember } from "../engine/agent-manager.js";
function service() { return new MemberArchiveService(getDatabase(),getBossmodeDir(),{quiesce:quiesceMember}); }
export function archiveMember(memberId: string, options: {confirm?:boolean}): Promise<{archived:string}> {
  return service().archive(memberId,options);
}
export function recoverMemberArchives(): Promise<void> { return service().recoverPending(); }
