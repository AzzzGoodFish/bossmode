// Centralized agent tool descriptions used by agent tool definitions.

export const QUERY_ROOM_MESSAGES_DESCRIPTION = `Search and retrieve messages from the current scope (or a target scope via the scope parameter — 'room:<id>' or 'dm:<memberId>', membership-checked; DM targets are served from the member-owned DM store). Without filters, returns the latest N messages (default 50). With filters, performs case-insensitive search by content, sender, or time range.

Use this tool when:
- You need to recall what was discussed earlier (beyond your current activation context)
- You need to find a specific decision, file path, error message, or quote
- You're investigating a bug and need to see what was reported
- You need to compile a summary or report of recent activity

For large result sets, set output="file" — the result is written to a temp markdown file and the path is returned. Read it with the Read tool to avoid context truncation.`;

export const LIST_SCOPES_DESCRIPTION = `List the scopes you belong to: your rooms (scope id 'room:<id>' + name) and your DM ('dm:<your-member-id>'). Read-only; the scope ids are accepted by the scope parameter of query_room_messages.`;

export const SHELL_CREATE_DESCRIPTION = `Open a persistent shell session (a real terminal) in a workspace. cwd and environment persist across commands; long-running processes keep running between tool calls. Defaults to the active workspace.`;

export const SHELL_EXEC_DESCRIPTION = `Run a command in a persistent shell and get its exact output plus exit code. Commands longer than blockUntilMs (default 10000ms) return as running — collect the rest later with shell_read. keys sends a control key (ctrl-c, ctrl-z, ctrl-d) instead of a command. One command at a time per shell: while an exec is running, a new command is rejected with the current exec id — wait (shell_wait), read (shell_read), send ctrl-c, or use another shell for independent work.`;

export const SHELL_READ_DESCRIPTION = `Read output from a persistent shell: by exec id (its exact output lines) or by absolute line range. Line numbers are the stable reference standard across reads.`;

export const SHELL_WAIT_DESCRIPTION = `Wait for a command (exec) on a persistent shell to finish. Done returns its exit code, line range and output; if the wait budget runs out first it returns running with the progress so far — wait again or snapshot with shell_read. Default wait 30000ms; blockUntilMs 0 waits until completion.`;

export const SHELL_LIST_DESCRIPTION = `List your shells with running exec, alive state, and buffered line counts.`;

export const SHELL_CLOSE_DESCRIPTION = `Close a shell and kill its process. Running commands receive a close signal.`;

export const WORKSPACE_LIST_DESCRIPTION = `List your workspaces with the active one marked.`;

export const WORKSPACE_CREATE_DESCRIPTION = `Register an ssh workspace (remote machine + directory). Use the id later in file tools via the workspace parameter, or make it active with workspace_use.`;

export const WORKSPACE_USE_DESCRIPTION = `Switch your active workspace. Relative paths in read/write/edit resolve against the active workspace root.`;

export const WORKSPACE_REMOVE_DESCRIPTION = `Remove a workspace by id. The builtin original workspace cannot be removed.`;

export const WORKSPACE_READ_DESCRIPTION = `Read a text file (or image on the original workspace). Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`;

export const WORKSPACE_WRITE_DESCRIPTION = `Write a file, creating parent directories as needed. Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`;

export const WORKSPACE_EDIT_DESCRIPTION = `Apply exact-match text replacements to a file. Every edit's oldText must match exactly once. Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`;

export const RELOAD_DESCRIPTION = `Rebuild your session in the current scope with freshly loaded assets (persona, skills, MCP, extensions, model config). Conversation history is preserved. Use after editing your persona.md, skills, or mcp.json. Queued until your current turn finishes if you are mid-run.`;

export const WAIT_DESCRIPTION = `Block until a room member posts a message, becomes idle, errors out of a turn, you are @-mentioned, or the timeout elapses.

This is a synchronous wait — your turn stays open (status stays working) until one of those events. Returns the target's message body when they post, or a short status for idle/error/timeout/mention interrupt. Cursor is not advanced — @-mentions while waiting are delivered by the normal activation path (they interrupt the wait); wait only reports that it ended.

If the target's turn fails (e.g. request terminated), wait wakes with reason "error" and tells you there was no output — verify status before continuing. Transient provider retries keep the target working and do not wake wait.

- member (required): target member name
- timeoutMinutes (optional): default 30, max 360

Only one wait at a time. If the target is already idle, returns immediately. Prefer wait over sleeping/polling.`;

// Parameter descriptions shared across runtimes
export const PARAM_DESCRIPTIONS = {
  workspaceId: "Optional workspace id (see workspace_list). Omit to use the active workspace.",
  sshHost: "Remote host (hostname or IP).",
  sshPort: "SSH port. Default 22.",
  sshUser: "Remote login user.",
  sshKeyPath: "Path to the private key file. Defaults to your member ssh key.",
  sshRoot: "Remote root directory for this workspace. Relative paths resolve against it. Default '.' (remote home).",
  shellName: "Optional short name for the shell (shows in shell_list).",
  shellCwd: "Starting directory. Defaults to the workspace root.",
  shellCommand: "The command line to run.",
  shellKeys: "Control key to send instead of a command: ctrl-c, ctrl-z, or ctrl-d.",
  shellBlockUntilMs: "Max milliseconds to wait before reporting the command as still running. Default 10000, 0 = never block — the command backgrounds immediately (use for servers/long builds), collect output later with shell_read.",
  shellWaitBlockUntilMs: "Max milliseconds to wait for the exec to finish. Default 30000; 0 waits until completion.",
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

} as const;
