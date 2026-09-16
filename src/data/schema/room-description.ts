import type { StorageMigration } from "../database.js";

/** ⑤ A (fish #20135): rooms carry an explicit description (name + description).
 * Description content previously lived in the room-scoped principles prompt
 * asset; `core-room-description-v1` adds the column, the startup step
 * (room-description-migration.ts) copies existing content in once. */
export const roomDescriptionMigration: StorageMigration = {
  id: "core-room-description-v1",
  sql: `ALTER TABLE rooms ADD COLUMN description TEXT;`,
};
