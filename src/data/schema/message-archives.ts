import type {StorageMigration} from "../database.js";
export const messageArchivesMigration:StorageMigration={id:"core-message-archives-v1",sql:`
CREATE TABLE message_archives (
 scope_id TEXT NOT NULL REFERENCES scopes(id),
 archive_ts INTEGER NOT NULL,
 has_messages INTEGER NOT NULL DEFAULT 0 CHECK(has_messages IN (0,1)),
 summary_json TEXT,
 PRIMARY KEY(scope_id,archive_ts)
);
INSERT INTO message_archives(scope_id,archive_ts,has_messages)
 SELECT DISTINCT scope_id,archive_ts,1 FROM message_archive_entries;
`};
