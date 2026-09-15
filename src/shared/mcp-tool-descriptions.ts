// Centralized agent tool descriptions used by agent tool definitions.

export const CHAT_READ_DESCRIPTION = `Read an ordered window of messages from one chat.

- chat (required): chat id or name — see chat_list.
- Window: latest by default; from_seq / around_seq position it, before / after bound it by time, limit sizes it.
- output: "file" writes the full window to a temp markdown file instead of returning it inline.

chat_search locates messages; read opens the context — feed a hit's seq to around_seq or from_seq.`;

export const CHAT_SEARCH_DESCRIPTION = `Search one chat's messages by text, sender or time; returns hits (seq, sender, time, snippet), newest first.

- chat (required): chat id or name — see chat_list.
- query (required): case-insensitive text to find.
- from / before / after / limit narrow the search.

search locates; read opens the context — feed a hit's seq to chat_read around_seq or from_seq.`;

export const CHAT_LIST_DESCRIPTION = `List the chats you participate in: type, name, id (and description). query filters by keyword; limit (default 50) and offset page through the list.`;

export const BOSSMODE_GATEWAY_DESCRIPTION = `Bossmode capabilities beyond the hot tools. \`list\` what is available, \`describe\` one capability's parameters, then \`call\` it with \`args\`. The hot tools (chat_send, chat_read, chat_search, chat_list) are registered directly — call them directly, not through here.`;

export const CHAT_INFO_DESCRIPTION = `One chat's details: name, description, and members (group chat) or counterpart (private chat). chat is an id or name.`;

export const CHAT_CREATE_DESCRIPTION = `Create a group chat: name, optional description, initial members (creator included). Private chats need no creation — chat_send opens one directly.`;

export const CHAT_EDIT_DESCRIPTION = `Edit a group chat: rename, update description, add or remove members by member id. Removing a member stops deliveries to them; history and memory are retained. chat is an id or name.`;

export const MEMBER_LIST_DESCRIPTION = `List members: id, name, description. query filters by keyword; limit (default 50) and offset page through the list.`;

export const MEMBER_INFO_DESCRIPTION = `One member's name, description and current status. member is a name or id. Read-only: never activates or notifies.`;

export const PROFILE_READ_DESCRIPTION = `Read your own profile: name, description and member id.`;

export const PROFILE_UPDATE_DESCRIPTION = `Update your own profile: name and/or description. An empty description clears it. Returns the stored profile and whether it changed.`;

export const TERMINAL_CREATE_DESCRIPTION = `Open a persistent terminal in a workspace. cwd and environment persist across commands; long-running processes keep running between tool calls. Defaults to the active workspace.`;

export const TERMINAL_EXEC_DESCRIPTION = `Run a command in a persistent terminal and get its exact output plus exit code. Commands longer than blockUntilMs (default 10000ms) return as running — collect the rest later with terminal_read. keys sends a control key (ctrl-c, ctrl-z, ctrl-d) instead of a command. One command at a time per terminal: while an exec is running, a new command is rejected with the current exec id — wait (terminal_wait), read (terminal_read), send ctrl-c, or use another terminal for independent work.`;

export const TERMINAL_READ_DESCRIPTION = `Read output from a persistent terminal: by exec id (its exact output lines) or by absolute line range. Line numbers are the stable reference standard across reads.`;

export const TERMINAL_WAIT_DESCRIPTION = `Wait for a command (exec) on a persistent terminal to finish. Done returns its exit code, line range and output; if the wait budget runs out first it returns running with the progress so far — wait again or snapshot with terminal_read. Default wait 30000ms; blockUntilMs 0 waits until completion.`;

export const TERMINAL_LIST_DESCRIPTION = `List your terminals with running exec, alive state, and buffered line counts.`;

export const TERMINAL_CLOSE_DESCRIPTION = `Close a terminal and kill its process. Running commands receive a close signal.`;

export const WORKSPACE_LIST_DESCRIPTION = `List your workspaces with the active one marked.`;

export const WORKSPACE_CREATE_DESCRIPTION = `Register an ssh workspace (remote machine + directory). Use the id later in file tools via the workspace parameter, or make it active with workspace_use.`;

export const WORKSPACE_USE_DESCRIPTION = `Switch your active workspace. Relative paths in read/write/edit resolve against the active workspace root.`;

export const WORKSPACE_REMOVE_DESCRIPTION = `Remove a workspace by id. The builtin original workspace cannot be removed.`;

export const WORKSPACE_READ_DESCRIPTION = `Read a text file (or image on the original workspace). Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`;

export const WORKSPACE_WRITE_DESCRIPTION = `Write a file, creating parent directories as needed. Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`;

export const WORKSPACE_EDIT_DESCRIPTION = `Apply exact-match text replacements to a file. Every edit's oldText must match exactly once. Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`;

export const RELOAD_DESCRIPTION = `Rebuild your session in the current scope with freshly loaded assets (persona, skills, MCP, extensions, model config). Conversation history is preserved. Use after editing your persona.md, skills, or mcp.json. Queued until your current turn finishes if you are mid-run.`;

// Parameter descriptions shared across runtimes
export const PARAM_DESCRIPTIONS = {
  workspaceId: "Optional workspace id (see workspace_list). Omit to use the active workspace.",
  sshHost: "Remote host (hostname or IP).",
  sshPort: "SSH port. Default 22.",
  sshUser: "Remote login user.",
  sshKeyPath: "Path to the private key file. Defaults to your member ssh key.",
  sshRoot: "Remote root directory for this workspace. Relative paths resolve against it. Default '.' (remote home).",
  terminalName: "Optional short name for the terminal (shows in terminal_list).",
  terminalCwd: "Starting directory. Defaults to the workspace root.",
  terminalCommand: "The command line to run.",
  terminalKeys: "Control key to send instead of a command: ctrl-c, ctrl-z, or ctrl-d.",
  terminalBlockUntilMs: "Max milliseconds to wait before reporting the command as still running. Default 10000, 0 = never block — the command backgrounds immediately (use for servers/long builds), collect output later with terminal_read.",
  terminalWaitBlockUntilMs: "Max milliseconds to wait for the exec to finish. Default 30000; 0 waits until completion.",
  // chat_read / chat_search
  query: "Case-insensitive substring to search in message content",
  from: "Filter by sender name (exact match, e.g. 'user' or 'developer')",
  after: "Only messages after this time: ISO timestamp or relative ('today', 'yesterday', '1h', '7d')",
  before: "Only messages before this time: same format as 'after'",
  around_seq: "Return a window of messages centered on the message with this seq (use with limit to control window size)",
  from_seq: "Return messages strictly after this seq (ascending) — reads the unread backlog the activation hint points at",
  limit: "Max messages to return (default 50, max 500)",
  output: "'text' returns inline (default). 'file' writes to a temp markdown file and returns the path — use Read tool to view it",
  // references
  chatRef: "Chat id or name (see chat_list).",
  memberRef: "Member name or id (see member_list).",
  // chat_list / member_list
  listQuery: "Keyword filter.",
  listLimit: "Max entries to return (default 50).",
  listOffset: "Skip this many entries (for paging).",
  // chat_create / chat_edit / profile
  chatDescription: "Description text; an empty string clears it.",
  createMembers: "Member ids to include; the creator is always included.",
  addMembers: "Member ids to add.",
  removeMembers: "Member ids to remove (history and memory are retained).",
  profileName: "New member name.",
  profileDescription: "New description; an empty string clears it.",
  // bossmode gateway
  gatewayAction: "One of: list, describe, call.",
  gatewayTool: "Capability name from action \"list\".",
  gatewayArgs: "Arguments object for the capability.",
} as const;
