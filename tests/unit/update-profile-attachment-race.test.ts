import { expect, it, vi } from "vitest";
import { closeTestServer, configureMockMemberModel, createTestServer, setupTestWorkspace } from "../helpers/test-server.js";

const importAttachments = vi.hoisted(() => vi.fn());
vi.mock("../../src/files/attachments.js", async () => ({
  ...(await vi.importActual<any>("../../src/files/attachments.js")),
  importAttachments,
}));
setupTestWorkspace();

async function runRenameDuringAttachmentImport(suffix: string) {
  const server = await createTestServer();
  try {
    const { createMember } = await import("../../src/app/member-actions.js");
    const rooms = await import("../../src/chat/conversations.js");
    const own = createMember({ name: `Sender-${suffix}` });
    const target = createMember({ name: `Target-${suffix}` });
    const reuse = createMember({ name: `Other-${suffix}` });
    const room = rooms.createRoom(`Attachment race ${suffix}`, [own.id, target.id, reuse.id]);
    await configureMockMemberModel(room.id, target.id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    importAttachments.mockImplementationOnce(async () => {
      await gate;
      return [{ ok: true, path: "simulated-IO", storedFilename: "stored.txt", originalFilename: "simulated.txt", size: 1 }];
    });
    const { handleToolCallback } = await import("../../src/agent/tools.js");
    const { updateProfileForMember } = await import("../../src/member/profile.js");
    const { getMember } = await import("../../src/member/identity.js");
    const { readMessages } = await import("../../src/chat/messages.js");
    const scope = `room:${room.id}`;
    const pending = handleToolCallback("chat_send", scope, own.name, {
      to: scope, message: `@Target-${suffix} answer`, attachments: ["simulated-IO"],
    }, { memberId: own.id });
    expect(importAttachments).toHaveBeenCalled();
    updateProfileForMember(target.id, { name: `Renamed-target-${suffix}` });
    updateProfileForMember(reuse.id, { name: `Target-${suffix}` });
    updateProfileForMember(own.id, { name: `Current-sender-${suffix}` });
    release();
    expect(await pending).toMatchObject({ ok: true, sourceRef: scope });
    const message = readMessages(scope).find(item => item.senderMemberId === own.id)!;
    return { message, own, target, currentSender: getMember(own.id)! };
  } finally {
    await closeTestServer(server);
  }
}

it("captures stable mention IDs before attachment IO despite a later name reuse", async () => {
  const { message, own, target } = await runRenameDuringAttachmentImport("mentions");
  expect(message).toMatchObject({
    senderMemberId: own.id,
    mentions: ["Target-mentions"],
    mentionMemberIds: [target.id],
  });
});

it("keeps the invocation-time sender label as an immutable fact while identity projection changes", async () => {
  const { message, own, currentSender } = await runRenameDuringAttachmentImport("sender");
  expect(message).toMatchObject({ sender: "Sender-sender", senderMemberId: own.id });
  expect(currentSender.name).toBe("Current-sender-sender");
});
