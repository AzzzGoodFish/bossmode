import type {StorageMigration} from "../database.js";

/** Append-only runtime orchestration state; never rewrite the applied J schema. */
export const runtimeInputsMigration:StorageMigration={
  id:"core-runtime-inputs-v1",
  sql:`
ALTER TABLE queued_inputs ADD COLUMN placement TEXT NOT NULL DEFAULT 'tail' CHECK(placement IN ('front','tail'));
CREATE INDEX queued_inputs_ready ON queued_inputs(scope_id,target_actor_key,status,placement,id);
CREATE TRIGGER queued_input_placement_guard BEFORE UPDATE ON queued_inputs
WHEN NEW.placement IS NOT OLD.placement
BEGIN SELECT RAISE(ABORT,'Queued input placement is immutable'); END;
CREATE TABLE reply_obligation_dispositions (
  scope_id TEXT NOT NULL, message_id TEXT NOT NULL, actor_key TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('failed','cancelled','silent','broadcast-skipped','continuation-exhausted')),
  diagnosis TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(scope_id,message_id,actor_key),
  FOREIGN KEY(scope_id,message_id,actor_key) REFERENCES reply_obligations(scope_id,message_id,actor_key)
);
CREATE TRIGGER reply_disposition_immutable BEFORE UPDATE ON reply_obligation_dispositions
BEGIN SELECT RAISE(ABORT,'Reply disposition is immutable'); END;
`,
};
