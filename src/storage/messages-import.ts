/** Mechanical source inventory for the parent's one-time, staged importer.
 * These paths are patterns, not live read/discovery functions. Never import backups as live duplicates.
 * Orphaned reference: no live code imports this module; the upgrade path uses legacy-inventory.ts
 * rules. Topic patterns describe retired sources — identified and consumed, never imported.
 */
export const messagesLegacySources = [
  {pattern:"rooms/<roomId>/messages.jsonl",kind:"messages",scope:"<roomId>"},
  {pattern:"rooms/<roomId>/.seq",kind:"next-message-sequence",scope:"<roomId>"},
  {pattern:"members/<memberId>/dm-messages.jsonl",kind:"messages",scope:"dm:<memberId>"},
  {pattern:"members/<memberId>/.dm-seq",kind:"next-message-sequence",scope:"dm:<memberId>"},
  {pattern:"members/<memberId>/dm-cursor.json",kind:"member-cursor",scope:"dm:<memberId>"},
  {pattern:"rooms/<roomId>/topics/<topicId>/messages.jsonl",kind:"messages",scope:"topic:<topicId>"},
  {pattern:"rooms/<roomId>/topics/<topicId>/.topic-seq",kind:"next-message-sequence",scope:"topic:<topicId>"},
  {pattern:"rooms/<roomId>/topics/<topicId>/cursors.json",kind:"member-cursors",scope:"topic:<topicId>"},
  {pattern:"rooms/<roomId>/agent-events/<owner>.jsonl",kind:"events",scope:"<roomId>"},
  {pattern:"rooms/dm:<memberId>/agent-events/<owner>.jsonl",kind:"events",scope:"dm:<memberId>"},
  {pattern:"rooms/<roomId>/topics/<topicId>/agent-events/<owner>.jsonl",kind:"events",scope:"topic:<topicId>"},
  {pattern:"rooms/<roomId>/archives/<timestamp>.jsonl",kind:"message-archive",scope:"<roomId>"},
  {pattern:"rooms/<roomId>/agent-events/<owner>.stats.json",kind:"retired-derived-stats",scope:"<roomId>"},
  {pattern:"rooms/dm:<memberId>/agent-events/<owner>.stats.json",kind:"retired-derived-stats",scope:"dm:<memberId>"},
  {pattern:"rooms/<roomId>/topics/<topicId>/agent-events/<owner>.stats.json",kind:"retired-derived-stats",scope:"topic:<topicId>"},
] as const;
export { importMessage, importMessageNextSequence, importArchivedMessage, writeMemberCursor, writeDmMemberCursor } from "./message-repository.js";
export { importAgentEvent, rebuildEventAggregates } from "./event-repository.js";
