import { getDatabase } from "../data/database.js";
import { appendMessageInTransaction, type MessageInput } from "../data/repositories/message-repository.js";
import { parseMmScopeId } from "../shared/conversation-ref.js";
import { executionScopeId } from "../data/repositories/execution-identity.js";
import { DeliveryRepository, type CapturedMessage, type DeliveryActor, type CapturedDeliverySnapshot } from "../data/repositories/delivery-repository.js";
import { ReplyObligationRepository } from "../data/repositories/reply-obligation-repository.js";
import { MembersRepository } from "../data/repositories/members.js";
import { getRoomMembers } from "../workspace/room-store.js";
import type { RoomMessage } from "../kernel/types.js";

/** No routing callback, filesystem work or SDK activity occurs in this transaction.
 * Supplied ID arrays, including [], are already-captured authority, never hints.
 */
export function appendCapturedMessage(scopeValue: string, input: MessageInput): RoomMessage {
  const scopeId = executionScopeId(scopeValue);
  const db = getDatabase();
  return db.transaction(() => {
    const members = new MembersRepository(db);
    const actor = (id: string): DeliveryActor => ({ actorKey: id, memberId: members.getRetained(id) ? id : null });
    const isDm = scopeId.startsWith("dm:");
    const isMm = scopeId.startsWith("mm:");
    let roster: Array<{ id: string; name: string }> | undefined;
    const ids = (provided: string[] | undefined, names: string[] | undefined): string[] => {
      if (provided !== undefined) return [...new Set(provided)];
      if (!names?.length) return [];
      if (!roster) {
        const owner = isDm ? members.getRetained(scopeId.slice(3)) : null;
        roster = isDm ? (owner ? [owner] : []) : isMm ? [] : getRoomMembers(scopeId);
      }
      if (names.includes("all")) return roster.map(member => member.id);
      const current = roster;
      return [...new Set(names.flatMap(name => current.filter(member => member.name === name).map(member => member.id)))];
    };
    // Match persisted JSON, including absent optional fields. Publish derived IDs
    // in the message/outbox too: renderers and wait listeners must see the same targets.
    const prepared = JSON.parse(JSON.stringify(input)) as MessageInput;
    if (!prepared.type && !isDm && !isMm) {
      if (prepared.mentionMemberIds === undefined) prepared.mentionMemberIds = ids(undefined, prepared.mentions);
    }
    if (prepared.needResponse !== undefined && prepared.needResponseMemberIds === undefined) prepared.needResponseMemberIds = ids(undefined, prepared.needResponse);
    const message = appendMessageInTransaction(db, scopeId, prepared);
    const sender = message.senderMemberId ? actor(message.senderMemberId) : null;
    const origin: CapturedDeliverySnapshot["origin"] = sender ? "member" : message.sender === "user" ? "user" : message.sender === "system" ? "system" : "unresolved";
    const messageType: CapturedDeliverySnapshot["messageType"] = message.type === "task_event" ? "task_event" : message.type === "knowledge_event" ? "knowledge_event" : message.type ? "notification" : "chat";
    const targets: CapturedDeliverySnapshot["targets"] = { ordinary: [], dm: [] };
    if (messageType === "chat") {
      if (isDm) {
        if (origin === "user") targets.dm = [actor(scopeId.slice(3))];
      } else if (isMm) {
        // Member↔member chat: every member-sent chat line is addressed to the other
        // member of the pair (delivery kind "ordinary"; a pair has exactly one peer).
        if (sender) {
          const pair = parseMmScopeId(scopeId);
          const other = pair?.find(id => id !== sender.memberId);
          if (other && members.getRetained(other)) targets.ordinary = [{ actorKey: other, memberId: other }];
        }
      } else {
        targets.ordinary = ids(message.mentionMemberIds, message.mentions).filter(id => id !== sender?.actorKey).map(actor);
      }
    }
    const needResponse = message.needResponseMemberIds !== undefined || message.needResponse !== undefined
      ? ids(message.needResponseMemberIds, message.needResponse).map(actor) : null;
    const capture: CapturedMessage = { scopeId, messageId: message.id, snapshot: {
      message: JSON.parse(JSON.stringify(message)), context: {}, origin, messageType,
      senderActorKey: sender?.actorKey ?? null, senderMemberId: sender?.memberId ?? null, targets, needResponse,
    } };
    new DeliveryRepository(db).captureMessage(capture, message.ts);
    const replies = new ReplyObligationRepository(db);
    replies.openForCapturedMessage(capture, message.ts);
    if (origin === "member" && messageType === "chat" && sender) {
      replies.settleOwnChat({ scopeId, replyMessageId: message.id, actorKey: sender.actorKey, selection: { mode: "all-pending" } }, message.ts);
    }
    return message;
  });
}
