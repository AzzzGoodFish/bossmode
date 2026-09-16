import type { StorageMigration } from "../database.js";
/** Apply after members + conversations + execution; parent owns production registration. */
export const memberArchivesMigration: StorageMigration = {
  id: "core-member-archives-v1",
  sql: `
CREATE TABLE member_archive_intents (
 member_id TEXT PRIMARY KEY REFERENCES members(id),
 source_path TEXT NOT NULL UNIQUE, archive_path TEXT NOT NULL UNIQUE,
 source_device TEXT NOT NULL, source_inode TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','completed')),
 created_at INTEGER NOT NULL, completed_at INTEGER,
 CHECK((state='pending' AND completed_at IS NULL) OR (state='completed' AND completed_at IS NOT NULL))
);
CREATE TABLE member_archives (
 archive_path TEXT NOT NULL, source_name TEXT NOT NULL,
 member_id TEXT REFERENCES members(id), kind TEXT NOT NULL CHECK(kind IN ('legacy','fired')),
 template TEXT NOT NULL, title TEXT, global_json TEXT NOT NULL CHECK(json_valid(global_json) AND json_type(global_json)='object'),
 persona_path TEXT, persona_format TEXT NOT NULL CHECK(persona_format IN ('plain','frontmatter')),
 has_persona INTEGER NOT NULL CHECK(has_persona IN (0,1)),
 PRIMARY KEY(archive_path,source_name)
);
CREATE UNIQUE INDEX member_archives_identity ON member_archives(member_id) WHERE member_id IS NOT NULL;
CREATE TABLE member_archive_rooms (
 archive_path TEXT NOT NULL, source_name TEXT NOT NULL, position INTEGER NOT NULL,
 room TEXT NOT NULL, has_principles INTEGER NOT NULL, has_mainline INTEGER NOT NULL,
 PRIMARY KEY(archive_path,source_name,position),
 FOREIGN KEY(archive_path,source_name) REFERENCES member_archives(archive_path,source_name)
);
CREATE TABLE member_archive_conflicts (
 archive_path TEXT NOT NULL, source_name TEXT NOT NULL, position INTEGER NOT NULL, conflict TEXT NOT NULL,
 PRIMARY KEY(archive_path,source_name,position),
 FOREIGN KEY(archive_path,source_name) REFERENCES member_archives(archive_path,source_name)
);
`,
};
