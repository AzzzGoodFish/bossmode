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

A task is a unit of work that someone can complete in a focused session.

**Side effect**: when you set assignee to an agent in this room, that agent is automatically activated and receives the task context. This replaces the need to send a separate @mention message after creating the task.

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

**Side effects**:
- Status changes are recorded as system messages in the room (others see progress).
- Reassigning to a different agent in this room automatically activates that agent.

Always update task status promptly — stale task states erode the team's awareness.

When updating description, **preserve previous content and append** your contribution (plans, findings, decisions). Do not overwrite — task descriptions are living records maintained by multiple actors.`;

export const LIST_TASKS_DESCRIPTION = `List tasks in the current room. Optionally filter by status or assignee.

Use this tool when:
- You need to see what's currently being worked on
- Before creating a task, to check for duplicates
- To find a task ID before updating it
- To compile a status report

Returns id, title, status, priority, assignee, references for each match.`;

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
  taskId: "Task ID to update",
  taskStatusFilter: "Filter: todo | in-progress | review | done",
  taskAssigneeFilter: "Filter by assignee name",
  taskReferences: "Reference document paths or URLs (e.g., 'docs/bossmode/prds/prd-x.md'). Soft links — file existence is not validated.",

  // write_summary
  summaryTitle: "Short topic title for this summary segment",
  summary: "1-3 sentence summary of the key content, decisions, and conclusions",
  summaryFromId: "Message ID of the first message in this segment",
  summaryToId: "Message ID of the last message in this segment",
} as const;
