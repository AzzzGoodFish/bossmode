import type { StorageMigration } from "../database.js";

/** Delivery intent snapshots only, never current-message or SDK history authority.
 * Scope retention is parent-owned. No live-message/member FK or delete cascade. */
export const deliveryMigration: StorageMigration = {
  id: "core-delivery-v1",
  sql: `
CREATE TABLE delivery_captures (
  scope_id TEXT NOT NULL REFERENCES scopes(id),
  message_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  captured_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id)
);
CREATE TRIGGER delivery_capture_immutable BEFORE UPDATE ON delivery_captures
BEGIN SELECT RAISE(ABORT,'Captured delivery is immutable'); END;
CREATE TABLE captured_deliveries (
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_actor_key TEXT NOT NULL,
  target_member_id TEXT,
  delivery_kind TEXT NOT NULL CHECK(delivery_kind IN ('ordinary','urgent','dm')),
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id,target_actor_key,delivery_kind),
  FOREIGN KEY(scope_id,message_id) REFERENCES delivery_captures(scope_id,message_id)
);
CREATE TRIGGER captured_delivery_immutable BEFORE UPDATE ON captured_deliveries
BEGIN SELECT RAISE(ABORT,'Delivery acceptance is immutable'); END;
CREATE TABLE reply_obligations (
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  member_id TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('user','explicit')),
  opened_at INTEGER NOT NULL,
  settled_at INTEGER,
  settled_by_message_id TEXT,
  PRIMARY KEY(scope_id,message_id,actor_key),
  FOREIGN KEY(scope_id,message_id) REFERENCES delivery_captures(scope_id,message_id),
  CHECK((settled_at IS NULL) = (settled_by_message_id IS NULL))
);
CREATE INDEX reply_obligations_pending ON reply_obligations(scope_id,actor_key,opened_at,message_id) WHERE settled_at IS NULL;
CREATE TRIGGER reply_obligation_guard BEFORE UPDATE ON reply_obligations
WHEN OLD.settled_at IS NOT NULL OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.message_id IS NOT OLD.message_id OR NEW.actor_key IS NOT OLD.actor_key
  OR NEW.member_id IS NOT OLD.member_id OR NEW.reason IS NOT OLD.reason
  OR NEW.opened_at IS NOT OLD.opened_at OR NEW.settled_at IS NULL
BEGIN SELECT RAISE(ABORT,'Invalid reply obligation transition'); END;
CREATE TABLE reply_settlements (
  scope_id TEXT NOT NULL,
  reply_message_id TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
  settled_count INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,reply_message_id,actor_key),
  FOREIGN KEY(scope_id,reply_message_id) REFERENCES delivery_captures(scope_id,message_id)
);
CREATE TRIGGER reply_settlement_immutable BEFORE UPDATE ON reply_settlements
BEGIN SELECT RAISE(ABORT,'Reply settlement is immutable'); END;
CREATE TABLE queued_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_actor_key TEXT NOT NULL,
  delivery_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  trigger TEXT NOT NULL CHECK(length(trigger)>0),
  status TEXT NOT NULL CHECK(status IN ('pending','dispatched','settled','interrupted','uncertain')),
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  ended_at INTEGER,
  dispatch_token TEXT,
  execution_attempt_id TEXT,
  outcome TEXT CHECK(outcome IN ('completed','failed','cancelled')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  diagnosis TEXT,
  UNIQUE(scope_id,message_id,target_actor_key,delivery_kind),
  FOREIGN KEY(scope_id,message_id,target_actor_key,delivery_kind)
    REFERENCES captured_deliveries(scope_id,message_id,target_actor_key,delivery_kind),
  CHECK((dispatch_token IS NULL) = (dispatched_at IS NULL)),
  CHECK(execution_attempt_id IS NULL OR dispatch_token IS NOT NULL),
  CHECK((status='pending' AND dispatched_at IS NULL AND ended_at IS NULL)
    OR (status='dispatched' AND dispatched_at IS NOT NULL AND ended_at IS NULL)
    OR (status='settled' AND dispatched_at IS NOT NULL AND ended_at IS NOT NULL AND outcome IS NOT NULL)
    OR (status='interrupted' AND dispatched_at IS NULL AND ended_at IS NOT NULL AND diagnosis IS NOT NULL)
    OR (status='uncertain' AND dispatched_at IS NOT NULL AND ended_at IS NOT NULL AND diagnosis IS NOT NULL)),
  CHECK(status='settled' OR (outcome IS NULL AND result_json IS NULL))
);
CREATE INDEX queued_inputs_pending ON queued_inputs(status,id);
CREATE INDEX queued_inputs_actor_pending ON queued_inputs(scope_id,target_actor_key,status,id);
CREATE TRIGGER queued_input_guard BEFORE UPDATE ON queued_inputs
WHEN NEW.id IS NOT OLD.id OR NEW.scope_id IS NOT OLD.scope_id
  OR NEW.message_id IS NOT OLD.message_id OR NEW.target_actor_key IS NOT OLD.target_actor_key
  OR NEW.delivery_kind IS NOT OLD.delivery_kind OR NEW.payload_json IS NOT OLD.payload_json
  OR NEW.trigger IS NOT OLD.trigger OR NEW.created_at IS NOT OLD.created_at
  OR NOT ((OLD.status='pending' AND NEW.status IN ('dispatched','interrupted'))
    OR (OLD.status='dispatched' AND NEW.status IN ('settled','uncertain')))
  OR (OLD.status='dispatched' AND (NEW.dispatch_token IS NOT OLD.dispatch_token
    OR NEW.execution_attempt_id IS NOT OLD.execution_attempt_id OR NEW.dispatched_at IS NOT OLD.dispatched_at))
BEGIN SELECT RAISE(ABORT,'Invalid queued input transition'); END;
`,
};
