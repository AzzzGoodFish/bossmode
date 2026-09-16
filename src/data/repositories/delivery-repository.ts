import type { Database } from "../database.js";

export type DeliveryJson = null | boolean | number | string | DeliveryJson[] | { [key: string]: DeliveryJson };
export type DeliveryKind = "ordinary" | "dm";
export interface DeliveryActor { actorKey: string; memberId: string | null }
export interface CapturedDeliverySnapshot {
  /** Original delivered bytes as JSON values, including historical labels/attachments.
   * Never use this snapshot as the current message/card/history read model. */
  message: { [key: string]: DeliveryJson };
  context: DeliveryJson;
  origin: "user" | "member" | "system" | "unresolved";
  messageType: "chat" | "task_event" | "knowledge_event" | "notification";
  senderActorKey: string | null;
  senderMemberId: string | null;
  /** Already captured, expanded and classified by the parent; [] means nobody.
   * actorKey may be a legacy scope-local ID. memberId is only supplied if proven. */
  targets: Record<DeliveryKind, DeliveryActor[]>;
  /** null = unspecified; [] = explicit FYI, including user-origin messages.
   * Nonempty lists add explicit debts for delivered actors; user origin already
   * debts all delivered actors unless explicitly FYI. */
  needResponse: DeliveryActor[] | null;
}
export interface CapturedMessage {
  scopeId: string;
  messageId: string;
  snapshot: CapturedDeliverySnapshot;
}
export interface DeliveryKey {
  scopeId: string;
  messageId: string;
  targetActorKey: string;
  deliveryKind: DeliveryKind;
}
export interface AcceptedDelivery extends DeliveryKey {
  targetMemberId: string | null;
  acceptedAt: number;
}

export function deliveryText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid delivery ${field}`);
}
export function deliveryTime(at: number): void {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid delivery timestamp");
}
/** Strict, canonical JSON: no silent loss of undefined/functions/NaN/class data. */
export function deliveryJson(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== "object" || ancestors.has(v)) throw new Error("Invalid delivery JSON");
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new Error("Invalid delivery JSON array");
        return `[${Array.from(v, encode).join(",")}]`;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("Invalid delivery JSON object");
      if (Object.getOwnPropertySymbols(v).length) throw new Error("Invalid delivery JSON symbols");
      return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key])}`).join(",")}}`;
    } finally { ancestors.delete(v); }
  };
  return encode(value);
}
function validateCapture(c: CapturedMessage): string {
  deliveryText(c.scopeId, "scope ID");
  deliveryText(c.messageId, "message ID");
  const s = c.snapshot;
  if (!s || !s.message || Array.isArray(s.message) || typeof s.message !== "object" || s.message.id !== c.messageId) throw new Error("Captured message ID mismatch");
  if (!["user", "member", "system", "unresolved"].includes(s.origin) || !["chat", "task_event", "knowledge_event", "notification"].includes(s.messageType)) throw new Error("Invalid delivery classification");
  if (s.senderActorKey !== null) deliveryText(s.senderActorKey, "sender actor key");
  if (s.senderMemberId !== null) {
    deliveryText(s.senderMemberId, "sender member ID");
    if (s.senderActorKey === null) throw new Error("Proven sender member requires actor key");
  }
  if (s.origin === "member" && s.senderActorKey === null) throw new Error("Member sender requires actor key");
  const actors = new Map<string, string | null>();
  if (s.senderActorKey !== null) actors.set(s.senderActorKey, s.senderMemberId);
  const validateActors = (list: DeliveryActor[]) => {
    if (!Array.isArray(list)) throw new Error("Captured target arrays are required");
    const keys = new Set<string>();
    for (const actor of list) {
      deliveryText(actor.actorKey, "target actor key");
      if (actor.memberId !== null) deliveryText(actor.memberId, "target member ID");
      if (keys.has(actor.actorKey)) throw new Error("Duplicate captured target actor");
      keys.add(actor.actorKey);
      if (actors.has(actor.actorKey) && actors.get(actor.actorKey) !== actor.memberId) throw new Error("Conflicting captured actor identity");
      actors.set(actor.actorKey, actor.memberId);
    }
  };
  if (!s.targets) throw new Error("Captured targets are required");
  for (const kind of ["ordinary", "dm"] as const) validateActors(s.targets[kind]);
  if (s.needResponse !== null) validateActors(s.needResponse);
  return deliveryJson(s);
}
export function deliveryKeyParams(key: DeliveryKey): [string, string, string, DeliveryKind] {
  deliveryText(key.scopeId, "scope ID");
  deliveryText(key.messageId, "message ID");
  deliveryText(key.targetActorKey, "target actor key");
  if (!["ordinary", "dm"].includes(key.deliveryKind)) throw new Error("Invalid delivery kind");
  return [key.scopeId, key.messageId, key.targetActorKey, key.deliveryKind];
}

/** SQL only. All methods can join a parent's common message transaction.
 * Returned inserted/accepted flags are provisional until its outer COMMIT. */
export class DeliveryRepository {
  constructor(private readonly db: Database) {}

  captureMessage(capture: CapturedMessage, at: number): { inserted: boolean; capture: CapturedMessage } {
    deliveryTime(at);
    const json = validateCapture(capture);
    return this.db.transaction(tx => {
      const scope = tx.get<{kind: string}>("SELECT kind FROM scopes WHERE id=?", capture.scopeId);
      if (!scope) throw new Error("Captured delivery scope does not exist");
      const targets = capture.snapshot.targets;
      if (scope.kind === "dm" ? targets.ordinary.length > 0 : targets.dm.length > 0) {
        throw new Error("Delivery kind does not match scope");
      }
      const old = tx.get<{snapshot_json: string}>("SELECT snapshot_json FROM delivery_captures WHERE scope_id=? AND message_id=?", capture.scopeId, capture.messageId);
      if (old && old.snapshot_json !== json) throw new Error("Conflicting captured message identity");
      if (!old) tx.run("INSERT INTO delivery_captures(scope_id,message_id,snapshot_json,captured_at) VALUES(?,?,?,?)", capture.scopeId, capture.messageId, json, at);
      return { inserted: !old, capture: { scopeId: capture.scopeId, messageId: capture.messageId, snapshot: JSON.parse(json) } };
    });
  }

  getCapture(scopeId: string, messageId: string): CapturedMessage | undefined {
    const row = this.db.get<{snapshot_json: string}>("SELECT snapshot_json FROM delivery_captures WHERE scope_id=? AND message_id=?", scopeId, messageId);
    return row ? { scopeId, messageId, snapshot: JSON.parse(row.snapshot_json) } : undefined;
  }

  getDelivery(key: DeliveryKey): AcceptedDelivery | undefined {
    return this.db.get<AcceptedDelivery>(`SELECT scope_id AS scopeId,message_id AS messageId,target_actor_key AS targetActorKey,
      target_member_id AS targetMemberId,delivery_kind AS deliveryKind,accepted_at AS acceptedAt FROM captured_deliveries
      WHERE scope_id=? AND message_id=? AND target_actor_key=? AND delivery_kind=?`, ...deliveryKeyParams(key));
  }

  /** Acceptance is durable routing bookkeeping, NOT callback/model/tool completion.
   * Compose acceptance + enqueue in one SQL transaction, then notify afterCommit. */
  acceptCapturedDelivery(input: DeliveryKey & { snapshot: CapturedDeliverySnapshot }, at: number): { accepted: boolean; delivery: AcceptedDelivery } {
    deliveryKeyParams(input);
    return this.db.transaction(tx => {
      const repo = new DeliveryRepository(tx);
      const { capture } = repo.captureMessage(input, at);
      const target = capture.snapshot.targets[input.deliveryKind].find(actor => actor.actorKey === input.targetActorKey);
      if (!target) throw new Error("Delivery actor is not a captured target");
      const scope = tx.get<{kind: string}>("SELECT kind FROM scopes WHERE id=?", input.scopeId);
      if ((scope?.kind === "dm") !== (input.deliveryKind === "dm")) throw new Error("Delivery kind does not match scope");
      const old = repo.getDelivery(input);
      if (old) return { accepted: false, delivery: old };
      tx.run(`INSERT INTO captured_deliveries(scope_id,message_id,target_actor_key,delivery_kind,target_member_id,accepted_at)
        VALUES(?,?,?,?,?,?)`, ...deliveryKeyParams(input), target.memberId, at);
      return { accepted: true, delivery: repo.getDelivery(input)! };
    });
  }
}

/** Explicit SQL-only entry point for parent router composition. */
export function acceptCapturedDelivery(db: Database, input: DeliveryKey & { snapshot: CapturedDeliverySnapshot }, at: number) {
  return new DeliveryRepository(db).acceptCapturedDelivery(input, at);
}
