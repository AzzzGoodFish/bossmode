import type { Database } from "../database.js";
import { DeliveryRepository, deliveryJson, deliveryText, deliveryTime, type CapturedMessage } from "./delivery-repository.js";

export type ReplyDisposition = "failed" | "cancelled" | "silent" | "broadcast-skipped" | "continuation-exhausted";

export interface ReplyObligation {
  scopeId: string;
  messageId: string;
  actorKey: string;
  memberId: string | null;
  reason: "user" | "explicit";
  openedAt: number;
  settledAt: number | null;
  settledByMessageId: string | null;
}
/** all-pending explicitly represents the legacy any-own-chat-clears-debt policy. */
export type ReplySelection = { mode: "all-pending" } | { mode: "reply-target"; messageId: string };
const SELECT = `SELECT scope_id AS scopeId,message_id AS messageId,actor_key AS actorKey,member_id AS memberId,
  reason,opened_at AS openedAt,settled_at AS settledAt,settled_by_message_id AS settledByMessageId FROM reply_obligations`;

const ACTIVE=`NOT EXISTS(SELECT 1 FROM reply_obligation_dispositions d WHERE d.scope_id=reply_obligations.scope_id AND d.message_id=reply_obligations.message_id AND d.actor_key=reply_obligations.actor_key)`;

/** No display-name lookup, task/subscription activation, runtime flags or callbacks. */
export class ReplyObligationRepository {
  constructor(private readonly db: Database) {}

  /** Parent invokes alongside message append in the common transaction, not after
   * a routing callback. Repeating after settlement cannot reopen an obligation. */
  openForCapturedMessage(capture: CapturedMessage, at: number): { opened: number } {
    return this.db.transaction(tx => {
      const { capture: stored } = new DeliveryRepository(tx).captureMessage(capture, at);
      const s = stored.snapshot;
      if (s.messageType !== "chat" || s.needResponse?.length === 0) return { opened: 0 };
      const targets = new Map([...s.targets.ordinary, ...s.targets.urgent, ...s.targets.dm].map(actor => [actor.actorKey, actor]));
      const required = s.origin === "user"
        ? new Set(targets.keys())
        : new Set((s.needResponse ?? []).map(actor => actor.actorKey));
      let opened = 0;
      for (const actorKey of required) {
        const actor = targets.get(actorKey);
        if (!actor || actorKey === s.senderActorKey) continue;
        const row = tx.get(`INSERT INTO reply_obligations(scope_id,message_id,actor_key,member_id,reason,opened_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(scope_id,message_id,actor_key) DO NOTHING RETURNING actor_key`,
        capture.scopeId, capture.messageId, actorKey, actor.memberId, s.origin === "user" ? "user" : "explicit", at);
        if (row) opened++;
      }
      return { opened };
    });
  }

  listPending(scopeId: string, actorKey: string): ReplyObligation[] {
    return this.db.all<ReplyObligation>(`${SELECT} WHERE scope_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE} ORDER BY opened_at,message_id`, scopeId, actorKey);
  }

  /** Records a non-reply terminal disposition without fabricating a member chat.
   * Omit messageIds only for explicit scope-wide cancellation, never prompt failure. */
  dismissPending(scopeId:string,actorKey:string,disposition:ReplyDisposition,diagnosis:string,at:number,messageIds?:string[]):number{
    deliveryText(scopeId,"scope ID");deliveryText(actorKey,"reply actor key");deliveryText(diagnosis,"reply diagnosis");deliveryTime(at);
    if(!["failed","cancelled","silent","broadcast-skipped","continuation-exhausted"].includes(disposition))throw new Error("Invalid reply disposition");
    if(messageIds?.length===0)return 0;
    messageIds?.forEach(id=>deliveryText(id,"message ID"));
    return this.db.transaction(tx=>tx.all(`INSERT INTO reply_obligation_dispositions(scope_id,message_id,actor_key,disposition,diagnosis,recorded_at)
      SELECT scope_id,message_id,actor_key,?,?,? FROM reply_obligations
      WHERE scope_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE}
      ${messageIds?`AND message_id IN (${messageIds.map(()=>"?").join(",")})`:""}
      ON CONFLICT(scope_id,message_id,actor_key) DO NOTHING RETURNING message_id`,disposition,diagnosis,at,scopeId,actorKey,...(messageIds??[])).length);
  }

  /** The reply must already have a capture in this transaction. Only its proven
   * member-origin chat sender can clear debt; labels, task and knowledge posts cannot.
   * Even zero-match settlements get receipts: replay never clears later debts. */
  settleOwnChat(input: { scopeId: string; replyMessageId: string; actorKey: string; selection: ReplySelection }, at: number): { applied: boolean; settled: number } {
    deliveryTime(at);
    deliveryText(input.actorKey, "reply actor key");
    if (input.selection.mode !== "all-pending" && input.selection.mode !== "reply-target") throw new Error("Invalid reply settlement selection");
    if (input.selection.mode === "reply-target") deliveryText(input.selection.messageId, "reply target ID");
    const selection = deliveryJson(input.selection);
    return this.db.transaction(tx => {
      const capture = new DeliveryRepository(tx).getCapture(input.scopeId, input.replyMessageId);
      if (!capture || capture.snapshot.origin !== "member" || capture.snapshot.messageType !== "chat" || capture.snapshot.senderActorKey !== input.actorKey) {
        throw new Error("Reply settlement requires the captured own chat sender");
      }
      const old = tx.get<{selection_json: string; settled_count: number}>(
        "SELECT selection_json,settled_count FROM reply_settlements WHERE scope_id=? AND reply_message_id=? AND actor_key=?", input.scopeId, input.replyMessageId, input.actorKey);
      if (old) {
        if (old.selection_json !== selection) throw new Error("Conflicting reply settlement identity");
        return { applied: false, settled: old.settled_count };
      }
      const targetSql = input.selection.mode === "reply-target" ? " AND message_id=?" : "";
      const targetParams = input.selection.mode === "reply-target" ? [input.selection.messageId] : [];
      const settled = tx.all(`UPDATE reply_obligations SET settled_at=?,settled_by_message_id=?
        WHERE scope_id=? AND actor_key=? AND settled_at IS NULL AND ${ACTIVE}${targetSql} RETURNING message_id`,
      at, input.replyMessageId, input.scopeId, input.actorKey, ...targetParams).length;
      tx.run(`INSERT INTO reply_settlements(scope_id,reply_message_id,actor_key,selection_json,settled_count,settled_at)
        VALUES(?,?,?,?,?,?)`, input.scopeId, input.replyMessageId, input.actorKey, selection, settled, at);
      return { applied: true, settled };
    });
  }
}
