// Centralized agent tool descriptions used by agent tool definitions.

export const QUERY_ROOM_MESSAGES_DESCRIPTION = `Search and retrieve messages from the current room. Without filters, returns the latest N messages (default 50). With filters, performs case-insensitive search by content, sender, or time range.

Use this tool when:
- You need to recall what was discussed earlier (beyond your current activation context)
- You need to find a specific decision, file path, error message, or quote
- You're investigating a bug and need to see what was reported
- You need to compile a summary or report of recent activity

For large result sets, set output="file" — the result is written to a temp markdown file and the path is returned. Read it with the Read tool to avoid context truncation.`;

export const CREATE_TASK_DESCRIPTION = `Create a task in the current room and return its id. Assignment and subscribers record ownership/watchers only; they never activate members.`;

export const UPDATE_TASK_DESCRIPTION = `Update fields of an existing task (status, assignee, priority, title, description, references, subscribers). Status changes are posted as room system messages. Assignment and subscriber changes never activate members.`;

export const LIST_TASKS_DESCRIPTION = `List tasks in the current room, optionally filtered by status or assignee. Returns id, title, status, priority, assignee, references, subscribers, and commentCount per task — comment bodies not included (use get_task).`;

export const GET_TASK_DESCRIPTION = `Get full details of a task: description, references, subscribers, and comments.`;

export const COMMENT_TASK_DESCRIPTION = `Add a markdown comment to a task. Comments are persisted on the task only: their content does not appear in the room stream (the room sees just a "commented on task" event) and they never activate members.`;

export const QUERY_INTEGRATION_DESCRIPTION = `Query external integration status for the current room.

Use this to check whether Linear is connected, see the current room's Linear team/project binding, inspect recent sync errors, and list available Linear teams/projects. API keys are never returned.`;

export const CONFIGURE_INTEGRATION_DESCRIPTION = `Configure an external integration for the current room.

For Linear v1, use this to bind the current room to a Linear team and optional project. Do not pass API keys; Linear API keys must be configured in Settings.`;

export const WAIT_DESCRIPTION = `Block until a room member posts a message, becomes idle, you are @-mentioned, or the timeout elapses.

This is a synchronous wait — your turn stays open (status stays working) until one of those events. Returns the target's message body when they post, or a short status for idle/timeout/mention interrupt. Cursor is not advanced — @-mentions while waiting are delivered via the normal activation/steer path; wait only reports that it ended.

- member (required): target member name
- timeoutMinutes (optional): default 30, max 360

Only one wait at a time. If the target is already idle, returns immediately. Prefer wait over sleeping/polling.`;

// Parameter descriptions shared across runtimes
export const PARAM_DESCRIPTIONS = {
  // query_room_messages
  query: "Case-insensitive substring to search in message content",
  from: "Filter by sender name (exact match, e.g. 'fish' or 'developer')",
  after: "Only messages after this time: ISO timestamp or relative ('today', 'yesterday', '1h', '7d')",
  before: "Only messages before this time: same format as 'after'",
  type: "Filter by message type (e.g. 'summary', 'task_event', 'knowledge_event')",
  around_seq: "Return a window of messages centered on the message with this seq (use with limit to control window size)",
  limit: "Max messages to return (default 50, max 500)",
  output: "'text' returns inline (default). 'file' writes to a temp markdown file and returns the path — use Read tool to view it",

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

  // integrations
  integrationProvider: "Integration provider. v1 supports only 'linear'.",
  integrationTeam: "Linear team name, key, or id. API key must already be configured in Settings.",
  integrationProject: "Optional Linear project name or id within the selected team.",
  integrationEnabled: "Enable or disable syncing for this room.",
} as const;
