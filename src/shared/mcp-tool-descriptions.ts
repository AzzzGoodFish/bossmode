// Centralized agent tool descriptions used by agent tool definitions.

export const QUERY_ROOM_MESSAGES_DESCRIPTION = `Search and retrieve messages from the current scope (or a target scope via the scope parameter — 'room:<id>' or 'dm:<memberId>', membership-checked; DM targets are served from the member-owned DM store). Without filters, returns the latest N messages (default 50). With filters, performs case-insensitive search by content, sender, or time range.

Use this tool when:
- You need to recall what was discussed earlier (beyond your current activation context)
- You need to find a specific decision, file path, error message, or quote
- You're investigating a bug and need to see what was reported
- You need to compile a summary or report of recent activity

For large result sets, set output="file" — the result is written to a temp markdown file and the path is returned. Read it with the Read tool to avoid context truncation.`;

export const CREATE_TASK_DESCRIPTION = `Create a task in the current room and return its id. Assignment and subscribers record ownership/watchers only; they never activate members.`;

export const UPDATE_TASK_DESCRIPTION = `Update fields of an existing task (status, assignee, priority, title, description, references, subscribers). Status changes are posted as room system messages. Assignment and subscriber changes never activate members.`;

export const LIST_TASKS_DESCRIPTION = `List tasks in the current room (or a target room via the scope parameter — 'room:<id>', membership-checked; tasks are room-scoped, a DM scope has no task list), optionally filtered by status or assignee. Returns id, title, status, priority, assignee, references, subscribers, and commentCount per task — comment bodies not included (use get_task).`;

export const GET_TASK_DESCRIPTION = `Get full details of a task: description, references, subscribers, and comments.`;

export const COMMENT_TASK_DESCRIPTION = `Add a markdown comment to a task. Comments are persisted on the task only: their content does not appear in the room stream (the room sees just a "commented on task" event) and they never activate members.`;

export const LIST_SCOPES_DESCRIPTION = `List the scopes you belong to: your rooms (scope id 'room:<id>' + name) and your DM ('dm:<your-member-id>'). Read-only; the scope ids are accepted by the scope parameter of query_room_messages / list_tasks / get_task / read_memory.`;

export const RELOAD_DESCRIPTION = `Rebuild your session in the current scope with freshly loaded assets (persona, skills, MCP, extensions, model config). Conversation history is preserved. Use after editing your member.md, skills, or mcp.json. Queued until your current turn finishes if you are mid-run.`;

export const WAIT_DESCRIPTION = `Block until a room member posts a message, becomes idle, errors out of a turn, you are @-mentioned, or the timeout elapses.

This is a synchronous wait — your turn stays open (status stays working) until one of those events. Returns the target's message body when they post, or a short status for idle/error/timeout/mention interrupt. Cursor is not advanced — @-mentions while waiting are delivered via the normal activation/steer path; wait only reports that it ended.

If the target's turn fails (e.g. request terminated), wait wakes with reason "error" and tells you there was no output — verify status before continuing. Transient provider retries keep the target working and do not wake wait.

- member (required): target member name
- timeoutMinutes (optional): default 30, max 360

Only one wait at a time. If the target is already idle, returns immediately. Prefer wait over sleeping/polling.`;

// Parameter descriptions shared across runtimes
export const PARAM_DESCRIPTIONS = {
  // query_room_messages
  query: "Case-insensitive substring to search in message content",
  from: "Filter by sender name (exact match, e.g. 'user' or 'developer')",
  after: "Only messages after this time: ISO timestamp or relative ('today', 'yesterday', '1h', '7d')",
  before: "Only messages before this time: same format as 'after'",
  type: "Filter by message type (e.g. 'task_event', 'knowledge_event')",
  around_seq: "Return a window of messages centered on the message with this seq (use with limit to control window size)",
  from_seq: "Return messages strictly after this seq (ascending) — reads the unread backlog the activation hint points at",
  limit: "Max messages to return (default 50, max 500)",
  output: "'text' returns inline (default). 'file' writes to a temp markdown file and returns the path — use Read tool to view it",
  scope: "Optional target scope: 'room:<id>' or 'dm:<memberId>' (membership-checked; default current scope)",

  // task tools
  taskTitle: "Task title",
  taskDescription: "Task description (markdown)",
  taskStatus: "todo | in-progress | review | done (default: todo)",
  taskStatusUpdate: "New status",
  taskPriority: "P0 | P1 | P2 (default: P1)",
  taskAssignee: "Member name to assign",
  taskSubscribers: "Passive watcher member names. Subscribers never activate members; use room chat exact @name only when requesting action/reply.",
  taskId: "Task ID",
  taskComment: "Markdown comment to append. Persisted on the task only — not shown in the room stream, does not activate members.",
  taskStatusFilter: "Filter: todo | in-progress | review | done",
  taskAssigneeFilter: "Filter by assignee name",
  taskReferences: "Reference document paths or URLs (e.g., 'docs/bossmode/prds/prd-x.md'). Soft links — file existence is not validated.",

} as const;
