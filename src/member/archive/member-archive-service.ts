import { getBossmodeDir } from "../../files/layout.js";
import { getDatabase } from "../../data/database.js";

import { MemberArchiveService } from "./member-archive-lifecycle.js";
import { quiesceMember } from "../../agent/orchestrator/agent-manager.js";
function service() { return new MemberArchiveService(getDatabase(),getBossmodeDir(),{quiesce:quiesceMember}); }
export function archiveMember(memberId: string, options: {confirm?:boolean}): Promise<{archived:string}> {
  return service().archive(memberId,options);
}
export function recoverMemberArchives(): Promise<void> { return service().recoverPending(); }
