# Session archives

Bossmode keeps SDK session JSONL under the owning member directory. You have **one session across all chats**: the live file lives in `sessions/<UTC day>/main/` and holds every chat's turns. A reset starts a new current session but preserves the old JSONL for later search. When the member-centric upgrade ran, session files from the retired per-chat layout were moved to `archive/sessions/<UTC day>/…`; they stay readable and searchable, they are just never resumed. The search commands below are read-only.

`list` and `search` report a `scope` label: `main` for the live member session, `room:<roomId>` or `dm:<memberId>` for archived per-chat files. Pass it to `--scope` to narrow to one of them.

Run session searches in the local original workspace, not in an SSH workspace. Use the absolute member directory shown in your Assets and the guide directory from this installed package:

```sh
GUIDE_DIR=/absolute/path/to/bossmode/assets/skills/bossmode-guide
MEMBER_DIR=/absolute/path/to/.bossmode/members/<memberId>

node "$GUIDE_DIR/scripts/session-search.mjs" --member-dir "$MEMBER_DIR" list \
  [--scope 'main|room:<roomId>|dm:<memberId>'] \
  [--from '<UTC ISO>'] [--to '<UTC ISO>'] [--limit 50]

node "$GUIDE_DIR/scripts/session-search.mjs" --member-dir "$MEMBER_DIR" search \
  --text '<literal text>' [--scope '<full scopeId>'] \
  [--from '<UTC ISO>'] [--to '<UTC ISO>'] \
  [--limit 50] [--max-bytes 65536]

node "$GUIDE_DIR/scripts/session-search.mjs" --member-dir "$MEMBER_DIR" expand \
  --file '<relative file returned by list/search>' --entry '<entryId>' \
  [--before 3] [--after 3] [--max-bytes 65536]
```

Output is NDJSON. `list` applies `--from` and `--to` to the session start time. `search` applies them to each record time, so a session that continued across UTC days remains searchable. Archived files are scanned too, so history from before the member-centric upgrade stays findable.

When the last row is `{"kind":"truncated","nextCursor":"..."}`, rerun the same action and filters with `--cursor '<nextCursor>'`. Do not change the action, file, entry, or filters between pages.

`expand` follows the selected entry's branch. An oversized entry is returned as several `entryChunk` strings. For one entry, concatenate its decoded `entryChunk` values in output and page order. When that entry's row has `entryComplete:true`, JSON-decode the accumulated string and clear the buffer before processing the next entry. Do not concatenate chunks from every entry into one JSON value. `entryOffset` counts JavaScript UTF-16 code units, so a page boundary can fall between the two code units of a non-BMP character; never decode an incomplete chunk as a complete entry by itself. `direct-child` means an immediate child branch, not the next physical JSONL line.

The script scans files read-only and never opens them through the SDK. It omits `thinkingSignature` and `encrypted_content`. Its realpath checks keep accidental paths and symlinks outside the supplied member directory from being read, but this is not a security boundary against another process running as the same operating-system account.

## Automatic storage upgrades

Supported storage upgrades run during normal startup, with backups and validation before consumers activate. Retired per-chat SDK files remain archived and searchable; they are not spliced into or resumed as the current member session. There are no standalone migration, apply, or recovery scripts.

If startup fails, preserve the database, original files, backups, and diagnostic logs. Resolve the reported issue and retry normal startup. Automatic recovery does not repair corrupt data or replace missing authoritative data; never delete the database or rewrite session references to bypass a failure.
