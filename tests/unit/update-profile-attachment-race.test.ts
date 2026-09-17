import { it, expect, vi } from "vitest";
import { setupTestWorkspace } from "../helpers/test-server.js";
setupTestWorkspace();
const processAttachments = vi.hoisted(() => vi.fn());
vi.mock("../../src/agent/orchestrator/agent-attachments.js", () => ({ processAgentAttachments: processAttachments }));

it("captures mention target IDs before attachment IO while refreshing the sender label after IO", async () => {
  const reg = await import("../../src/member/identity.js"), __reg_app_member_actions = await import("../../src/app/member-actions.js");
  const rooms = await import("../../src/chat/conversations.js");
  const own = __reg_app_member_actions.createMember({ name: "Sender" });
  const target = __reg_app_member_actions.createMember({ name: "Target" });
  const reuse = __reg_app_member_actions.createMember({ name: "Other" });
  const room = rooms.createRoom("Attachment race", undefined, []);
  rooms.stampGlobalMemberIds(room.id, [own.id, target.id, reuse.id]);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  processAttachments.mockImplementation(async () => { await gate; return []; });
  const { handleToolCallback, loadScopeMessages } = await import("../../src/agent/tools/tools.js");
  const { updateProfileForMember } = await import("../../src/member/profile.js");
  const router = await import("../../src/chat/router.js");
  const activate = vi.fn();
  const stop = router.initRouter({mention:activate});
  try {
    const pending = handleToolCallback("chat_send", room.id, own.name, { message: "@Target answer", attachments: ["simulated-IO"] }, { memberId: own.id });
    expect(processAttachments).toHaveBeenCalledOnce();
    updateProfileForMember(target.id, { name: "Renamed target" });
    updateProfileForMember(reuse.id, { name: "Target" });
    updateProfileForMember(own.id, { name: "Current sender" });
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(activate).toHaveBeenCalledWith(room.id, target.id, expect.objectContaining({ senderOrigin: "member" }));
    expect(loadScopeMessages(room.id).at(-1)?.needResponseMemberIds).toBeUndefined();
    expect(loadScopeMessages(room.id).at(-1)).toMatchObject({ sender: "Current sender", senderMemberId: own.id, mentions: ["Target"], mentionMemberIds: [target.id] });
  } finally { release(); stop(); }
});
