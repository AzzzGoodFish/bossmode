// Centralized agent tool descriptions used by pi-cli extension generation.

export const QUERY_ROOM_MESSAGES_DESCRIPTION = `Search and retrieve messages from the current room. Without filters, returns the latest N messages (default 50). With filters, performs case-insensitive search by content, sender, or time range.

Use this tool when:
- You need to recall what was discussed earlier (beyond your current activation context)
- You need to find a specific decision, file path, error message, or quote
- You're investigating a bug and need to see what was reported
- You need to compile a summary or report of recent activity

For large result sets, set output="file" — the result is written to a temp markdown file and the path is returned. Read it with the Read tool to avoid context truncation.`;

export const CREATE_TASK_DESCRIPTION = `Create a task in the current room.

Use this tool when:
- You receive a user request that needs tracking — decompose into one or more tasks
- You discover a bug, tech debt, or follow-up item during your work
- You hand off work to another agent and want a tracked record
- A discussion produces an actionable item that shouldn't be forgotten

A task is a unit of work that someone can complete in a focused session. Use description for stable requirements, scope, and acceptance criteria; use comment_task for process notes, implementation progress, QA results, blockers, and handoff records.

Assignment and subscribers record ownership/watchers only. They never activate members. To request a member's reply, send a room chat message with exact @name.

When you should NOT create a task:
- The work is so small it fits in a single agent turn (just do it)
- A similar task already exists (use list_tasks first to check)
- The request is informational only (use chat to respond instead)`;

export const UPDATE_TASK_DESCRIPTION = `Update an existing task in the current room.

Use this tool when:
- You start working on a task → set status to "in-progress"
- You finish your part → set status to "review"
- Verification passed → set status to "done" (typically QA or PM)
- Priority or scope changes → update fields accordingly
- Task gets reassigned → update assignee

Task event messages:
- Status changes are recorded as system messages in the room so others see progress.
- Assignment and subscribers record ownership/watchers only. They never activate members. To request a member's reply, send a room chat message with exact @name.

Always update task status promptly — stale task states erode the team's awareness.

Description is for stable requirements, scope, and acceptance criteria. Use comment_task for process notes, implementation progress, QA results, blockers, and handoff records.`;

export const LIST_TASKS_DESCRIPTION = `List tasks in the current room. Optionally filter by status or assignee.

Use this tool when:
- You need to see what's currently being worked on
- Before creating a task, to check for duplicates
- To find a task ID before updating it
- To compile a status report

Returns id, title, status, priority, assignee, references, subscribers, and commentCount for each match. It does not return full comment bodies; use get_task for full detail.`;

export const GET_TASK_DESCRIPTION = `Get full details for a task in the current room, including description, references, subscribers, and comments.

Use this before adding a subscriber, when you need task context before implementation or QA, or when list_tasks only returned a summary.`;

export const COMMENT_TASK_DESCRIPTION = `Add a comment to a task in the current room.

Use comments for implementation notes, QA results, blockers, decisions, and handoff records. Comments are persisted on the task but do not activate members, even if the text contains @name. To request action, send a room chat message with exact @name.`;

export const QUERY_INTEGRATION_DESCRIPTION = `Query external integration status for the current room.

Use this to check whether Linear is connected, see the current room's Linear team/project binding, inspect recent sync errors, and list available Linear teams/projects. API keys are never returned.`;

export const CONFIGURE_INTEGRATION_DESCRIPTION = `Configure an external integration for the current room.

For Linear v1, use this to bind the current room to a Linear team and optional project. Do not pass API keys; Linear API keys must be configured in Settings.`;

export const WRITE_SUMMARY_DESCRIPTION = `Create a topic-based summary message that covers a range of messages. Only callable by the summarizer agent.

Use this when a contiguous segment of messages forms a coherent topic that can be condensed into a 1-3 sentence summary. The original messages remain in storage but the summary becomes the canonical view in the merged message stream.`;

// Parameter descriptions shared across runtimes
export const PARAM_DESCRIPTIONS = {
  // query_room_messages
  query: "Case-insensitive substring to search in message content",
  from: "Filter by sender name (exact match, e.g. 'fish' or 'developer')",
  after: "Only messages after this time: ISO timestamp or relative ('today', 'yesterday', '1h', '7d')",
  before: "Only messages before this time: same format as 'after'",
  limit: "Max messages to return (default 50, max 500)",
  output: "'text' returns inline (default). 'file' writes to a temp markdown file and returns the path — use Read tool to view it",

  // task tools
  taskTitle: "Task title",
  taskDescription: "Task description (markdown)",
  taskStatus: "todo | in-progress | review | done (default: todo)",
  taskStatusUpdate: "New status",
  taskPriority: "P0 | P1 | P2 (default: P1)",
  taskAssignee: "Member name to assign",
  taskSubscribers: "Passive watcher member names. Subscribers never activate members; use room chat exact @name to request action.",
  taskId: "Task ID",
  taskComment: "Markdown comment to append to the task. Does not activate members.",
  taskStatusFilter: "Filter: todo | in-progress | review | done",
  taskAssigneeFilter: "Filter by assignee name",
  taskReferences: "Reference document paths or URLs (e.g., 'docs/bossmode/prds/prd-x.md'). Soft links — file existence is not validated.",

  // integrations
  integrationProvider: "Integration provider. v1 supports only 'linear'.",
  integrationTeam: "Linear team name, key, or id. API key must already be configured in Settings.",
  integrationProject: "Optional Linear project name or id within the selected team.",
  integrationEnabled: "Enable or disable syncing for this room.",

  // write_summary
  summaryTitle: "Short topic title for this summary segment",
  summary: "1-3 sentence summary of the key content, decisions, and conclusions",
  summaryFromId: "Message ID of the first message in this segment",
  summaryToId: "Message ID of the last message in this segment",
} as const;
