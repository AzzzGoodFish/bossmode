import { Type, type TSchema } from "typebox";
import { getUserDisplayName } from "../config/settings.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { awaitResourceClose, memberTerminalWorkspace, createShell, execInShell, readShell, waitShell, listShells, closeShell, type TerminalWorkspace } from "./terminal.js";
import { memberRuntimeAllowed } from "./instance.js";
import { logger } from "../kernel/logger.js";
import { readTextOutput, TOOL_OUTPUT_LIMIT } from "./runtime/tool-output.js";
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
  terminalBlockSeconds: "Max seconds to wait before reporting the command as still running. Default 10, 0 = never block — the command backgrounds immediately (use for servers/long builds), collect output later with terminal_read.",
  terminalWaitBlockSeconds: "Max seconds to wait for the exec to finish. Default 30; 0 waits until completion.",
  query: "Case-insensitive substring to search in message content",
  from: "Filter by sender name (exact match, e.g. 'user' or 'developer')",
  after: "Only messages after this time: ISO timestamp or relative ('today', 'yesterday', '1h', '7d')",
  before: "Only messages before this time: same format as 'after'",
  around_seq: "Return a window of messages centered on the message with this seq (use with limit to control window size)",
  from_seq: "Return messages strictly after this seq (ascending) — reads the unread backlog the activation hint points at",
  limit: "Max messages to return (default 50, max 500)",
  output: "'text' returns inline (default). 'file' writes to a temp markdown file and returns the path — use Read tool to view it",
  chatRef: "Chat id or name (see chat_list).",
  memberRef: "Member name or id (see member_list).",
  listQuery: "Keyword filter.",
  listLimit: "Max entries to return (default 50).",
  listOffset: "Skip this many entries (for paging).",
  chatTo: "Target chat id or name; your private chat with the user is \"dm:<your member id>\" (or \"user\").",
  chatMessage: "Message to post. @name activates that member (exact match required; a plain name never activates).",
  chatAttachments: "Local file paths to attach. Files are copied into that chat's attachment store.",
  chatName: "Group chat name.",
  chatDescription: "Group chat description (≤2000 characters); an empty string clears it.",
  workspaceRegistrationId: "Workspace id — letters, digits, dot, dash, underscore.",
  workspaceTargetId: "Workspace id (see workspace_list).",
  workspaceDescription: "Short human-readable description.",
  filePath: "File path — relative paths resolve against the selected workspace.",
  fileOffset: "Line number to start from (1-indexed).",
  fileLimit: `Maximum lines to read (output capped at ${TOOL_OUTPUT_LIMIT}).`,
  fileContent: "Full file content to write.",
  fileEdits: "Exact-match text replacements to apply in order.",
  fileEditOldText: "Exact text to find; it must match exactly once.",
  fileEditNewText: "Replacement text to write in place of oldText.",
  terminalId: "Terminal id from terminal_create / terminal_list.",
  terminalExecId: "Exec id (for example, e3).",
  terminalFromLine: "First absolute line number to read.",
  terminalToLine: "Last absolute line number to read.",
  createMembers: "Member ids to include; the creator is always included.",
  addMembers: "Member ids to add.",
  removeMembers: "Member ids to remove (history and memory are retained).",
  profileName: "New member name.",
  profileDescription: "New description; an empty string clears it.",
  gatewayAction: "One of: list, describe, call.",
  gatewayTool: "Capability name from action \"list\".",
  gatewayArgs: "Arguments object for the capability.",
} as const;
const PARAMETER_ALIASES:Record<string,string>={workspace:"workspaceId",host:"sshHost",port:"sshPort",user:"sshUser",keyPath:"sshKeyPath",root:"sshRoot",chat:"chatRef",member:"memberRef",members:"createMembers",add_members:"addMembers",remove_members:"removeMembers",action:"gatewayAction",tool:"gatewayTool",args:"gatewayArgs",cwd:"terminalCwd",command:"terminalCommand",keys:"terminalKeys",blockSeconds:"terminalBlockSeconds"};
function parameterSchema(spec="",aliases:Record<string,string>={}):TSchema{
  const descriptions=PARAM_DESCRIPTIONS as Record<string,string>;
  const properties=Object.fromEntries(spec?spec.split(" ").map(field=>{const [raw,kind]=field.split(":"),optional=raw!.endsWith("?"),name=optional?raw!.slice(0,-1):raw!,description=descriptions[aliases[name]??PARAMETER_ALIASES[name]??name]??name;
    let value:TSchema=kind==="n"?Type.Number({description}):kind==="as"?Type.Array(Type.String(),{description}):kind==="any"?Type.Any({description}):kind==="edits"?Type.Array(Type.Object({oldText:Type.String({description:descriptions.fileEditOldText}),newText:Type.String({description:descriptions.fileEditNewText})}),{description}):Type.String({description});
    if(optional)value=Type.Optional(value);return [name,value];}):[]);
  return Type.Object(properties,{additionalProperties:false});
}
export interface GatewayToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  example: Record<string, unknown>;
}
const gatewaySpec=(name:string,label:string,description:string,parameters:TSchema,example:Record<string,unknown>):GatewayToolSpec=>({name,label,description,parameters,example});
export const GATEWAY_TOOL_SPECS: GatewayToolSpec[] = [
  gatewaySpec("chat_info","Chat Info",`One chat's details: name, description, and members (group chat) or counterpart (private chat). chat is an id or name.`,parameterSchema("chat:s"),{ chat: "user" }),
  gatewaySpec("chat_create","Chat Create",`Create a group chat: name, optional description, initial members (creator included). Private chats need no creation — chat_send opens one directly.`,parameterSchema("name:s description?:s members?:as",{name:"chatName",description:"chatDescription"}),{ name: "<group chat name>" }),
  gatewaySpec("chat_edit","Chat Edit",`Edit a group chat: rename, update description, add or remove members by member id. Removing a member stops deliveries to them; history and memory are retained. chat is an id or name.`,parameterSchema("chat:s name?:s description?:s add_members?:as remove_members?:as",{name:"chatName",description:"chatDescription"}),{ chat: "<chat id or name>", name: "<new name>" }),
  gatewaySpec("member_list","Member List",`List members: id, name, description. query filters by keyword; limit (default 50) and offset page through the list.`,parameterSchema("query?:s limit?:n offset?:n",{query:"listQuery",limit:"listLimit",offset:"listOffset"}),{}),
  gatewaySpec("member_info","Member Info",`One member's name, description and current status. member is a name or id. Read-only: never activates or notifies.`,parameterSchema("member:s"),{ member: "<member name or id>" }),
  gatewaySpec("profile_read","Profile Read",`Read your own profile: name, description and member id.`,parameterSchema(""),{}),
  gatewaySpec("profile_update","Profile Update",`Update your own profile: name and/or description. An empty description clears it. Returns the stored profile and whether it changed.`,parameterSchema("name?:s description?:s",{name:"profileName",description:"profileDescription"}),{ description: "<your description>" }),
];
export interface DirectToolSpec {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
}
const directSpec=(name:string,label:string,description:string,parameters:TSchema):DirectToolSpec=>({name,label,description,parameters});
export const DIRECT_TOOL_SPECS: DirectToolSpec[] = [
  directSpec("chat_send","Chat Send",`Send a message to one chat.
- to (required): target chat — id or name; your private chat with the user is "dm:<your member id>" (or "user"). Private chats need no prior creation.
- message (required): text content.
- attachments (optional): local file paths, copied into that chat's attachment store.`,parameterSchema("to:s message:s attachments?:as",{to:"chatTo",message:"chatMessage",attachments:"chatAttachments"})),
  directSpec("chat_read","Chat Read",`Read an ordered window of messages from one chat.

- chat (required): chat id or name — see chat_list.
- Window: latest by default; from_seq / around_seq position it, before / after bound it by time, limit sizes it.
- output: "file" writes the full window to a temp markdown file instead of returning it inline.

chat_search locates messages; read opens the context — feed a hit's seq to around_seq or from_seq.`,parameterSchema("chat:s from_seq?:n around_seq?:n before?:s after?:s limit?:n output?:s")),
  directSpec("chat_search","Chat Search",`Search one chat's messages by text, sender or time; returns hits (seq, sender, time, snippet), newest first.

- chat (required): chat id or name — see chat_list.
- query (required): case-insensitive text to find.
- from / before / after / limit narrow the search.

search locates; read opens the context — feed a hit's seq to chat_read around_seq or from_seq.`,parameterSchema("chat:s query:s from?:s before?:s after?:s limit?:n")),
  directSpec("chat_list","Chat List",`List the chats you participate in: type, name, id (and description). query filters by keyword; limit (default 50) and offset page through the list.`,parameterSchema("query?:s limit?:n offset?:n",{query:"listQuery",limit:"listLimit",offset:"listOffset"})),
  directSpec("bossmode","Bossmode",`Bossmode capabilities beyond the hot tools. \`list\` what is available, \`describe\` one capability's parameters, then \`call\` it with \`args\`. The hot tools (chat_send, chat_read, chat_search, chat_list) are registered directly — call them directly, not through here.`,parameterSchema("action:s tool?:s args?:any")),
  directSpec("workspace_list","Workspace List",`List your workspaces with the active one marked.`,parameterSchema("")),
  directSpec("workspace_create","Workspace Create",`Register an ssh workspace (remote machine + directory). Use the id later in file tools via the workspace parameter, or make it active with workspace_use.`,parameterSchema("id:s host:s user:s port?:n keyPath?:s root?:s description?:s",{id:"workspaceRegistrationId",description:"workspaceDescription"})),
  directSpec("workspace_use","Workspace Use",`Switch your active workspace. Relative paths in read/write/edit resolve against the active workspace root.`,parameterSchema("id:s",{id:"workspaceTargetId"})),
  directSpec("workspace_remove","Workspace Remove",`Remove a workspace by id. The builtin original workspace cannot be removed.`,parameterSchema("id:s",{id:"workspaceTargetId"})),
  directSpec("read","Read File",`Read a text file (or image on the original workspace). Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace. Text output is capped at ${TOOL_OUTPUT_LIMIT}. Use the returned offset to continue; oversized single lines include a terminal_exec fallback.`,parameterSchema("path:s offset?:n limit?:n workspace?:s",{path:"filePath",offset:"fileOffset",limit:"fileLimit"})),
  directSpec("write","Write File",`Write a file, creating parent directories as needed. Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`,parameterSchema("path:s content:s workspace?:s",{path:"filePath",content:"fileContent"})),
  directSpec("edit","Edit File",`Apply exact-match text replacements to a file. Every edit's oldText must match exactly once. Relative paths resolve against the active workspace root; pass workspace (id) to target another workspace.`,parameterSchema("path:s edits:edits workspace?:s",{path:"filePath",edits:"fileEdits"})),
  directSpec("terminal_create","Terminal Create",`Open a persistent terminal in a workspace. cwd and environment persist across commands; long-running processes keep running between tool calls. Defaults to the active workspace.`,parameterSchema("name?:s workspace?:s cwd?:s",{name:"terminalName"})),
  directSpec("terminal_exec","Terminal Exec",`Run a command in a persistent terminal and get its output plus exit code. Output is capped at ${TOOL_OUTPUT_LIMIT}; oversized output returns the tail and a full-output snapshot path (read with workspace=original). Commands that take longer than blockSeconds (default 10, in seconds) return as running — collect the rest later with terminal_read. keys sends a control key (ctrl-c, ctrl-z, ctrl-d) instead of a command. One command at a time per terminal: while an exec is running, a new command is rejected with the current exec id — wait (terminal_wait), read (terminal_read), send ctrl-c, or use another terminal for independent work.`,parameterSchema("terminalId:s command?:s keys?:s blockSeconds?:n",{terminalId:"terminalId"})),
  directSpec("terminal_read","Terminal Read",`Read output from a persistent terminal: by exec id (its exact output lines) or by absolute line range. Line numbers are the stable reference standard across reads. Output is capped at ${TOOL_OUTPUT_LIMIT}; oversized output returns the tail and a full-output snapshot path (read with workspace=original).`,parameterSchema("terminalId:s exec?:s fromLine?:n toLine?:n",{terminalId:"terminalId",exec:"terminalExecId",fromLine:"terminalFromLine",toLine:"terminalToLine"})),
  directSpec("terminal_wait","Terminal Wait",`Wait for a command (exec) on a persistent terminal to finish. Done returns its exit code, line range and output; if the wait budget runs out first it returns running with the progress so far — wait again or snapshot with terminal_read. Default wait 30 seconds; blockSeconds 0 waits until completion. Output is capped at ${TOOL_OUTPUT_LIMIT}; oversized output returns the tail and a full-output snapshot path (read with workspace=original).`,parameterSchema("terminalId:s exec:s blockSeconds?:n",{terminalId:"terminalId",exec:"terminalExecId",blockSeconds:"terminalWaitBlockSeconds"})),
  directSpec("terminal_list","Terminal List",`List your terminals with running exec, alive state, and buffered line counts.`,parameterSchema("")),
  directSpec("terminal_close","Terminal Close",`Close a terminal and kill its process. Running commands receive a close signal.`,parameterSchema("terminalId:s",{terminalId:"terminalId"})),
  directSpec("reload","Reload",`Rebuild your session in the current scope with freshly loaded assets (persona, skills, MCP, extensions, model config). Conversation history is preserved. Use after editing your persona.md, skills, or mcp.json. Queued until your current turn finishes if you are mid-run.`,parameterSchema("")),
];
function senderDisplayName(sender: string): string {
  return sender === "user" ? getUserDisplayName() : sender;
}
export interface QueryRowReplyTo {
  seq: number;
  messageId: string;
  sender?: string;
  excerpt?: string;
  unavailable?: boolean;
}
export interface QueryRow {
  seq?: number;
  sender: string;
  content: string;
  ts?: number;
  replyTo?: QueryRowReplyTo;
  attachments?: Array<{ originalFilename: string; path?: string; unavailable?: boolean }>;
}
function replyToLine(replyTo: QueryRowReplyTo): string {
  if (replyTo.unavailable || !replyTo.sender || !replyTo.excerpt) {
    return `[In reply to msg:#${replyTo.seq} — original not visible in this context]`;
  }
  return `[In reply to msg:#${replyTo.seq} from ${senderDisplayName(replyTo.sender)}]: "${replyTo.excerpt}"`;
}

function attachmentLines(attachments: QueryRow["attachments"]): string[] {
  return (attachments || []).map(a=>a.unavailable||!a.path
    ?`Attachment unavailable: ${a.originalFilename}`
    :`Attachment: [original filename: ${a.originalFilename}](${a.path})`);
}

/** Render one row as the member sees it: header + reply quote + content + attachments. */
export function renderQueryRowForMember(row: QueryRow): string {
  const seq = row.seq !== undefined ? `No.${row.seq}` : "";
  const time = typeof row.ts === "number" ? new Date(row.ts).toISOString() : "";
  const headerBits = [seq, senderDisplayName(row.sender), time].filter(Boolean).join(" · ");
  const parts: string[] = [`[${headerBits}]`];
  if (row.replyTo) parts.push(replyToLine(row.replyTo));
  if (row.content?.trim()) parts.push(row.content);
  parts.push(...attachmentLines(row.attachments));
  return parts.filter((p) => p !== "").join("\n");
}

/** Render a page of rows (blank line between messages). */
export function renderQueryRowsForMember(rows: QueryRow[]): string {
  if (rows.length === 0) return "No messages found.";
  return rows.map((m) => renderQueryRowForMember(m)).join("\n\n");
}

/**
 * Batch 7 P1 (spec §3): workspace-aware file tools — read/write/edit override
 * pi's built-ins by name (the SDK tool registry lets custom tools shadow
 * built-ins). Relative paths resolve against the active workspace root; the
 * optional `workspace` parameter picks a workspace by id. original = whole
 * local machine, no fence (fish: 整机不限制); ssh workspaces read/write over
 * sftp with a cached connection per workspace.
 */

export interface WorkspacePathResolution {
  workspace: TerminalWorkspace;
  /** For original: an absolute local path. For ssh: a remote path (may be relative to the workspace root). */
  path: string;
}

export function resolveWorkspacePath(memberId: string, rawPath: string, workspaceId?: string): WorkspacePathResolution | { error: string } {
  if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
    return { error: "path is required" };
  }
  const p = rawPath.trim();
  const workspace = memberTerminalWorkspace(memberId,workspaceId);
  if (!workspace) {
    return { error: `Workspace not found: ${workspaceId}` };
  }
  const path = isAbsolute(p) ? p : join(workspace.root, p);
  return { workspace, path };
}

// ── ssh sftp pool (cached connection per member+workspace) ──

interface PooledClient {
  conn: any;
  sftp: any;
  ready: Promise<void>;
  failed: boolean;
  closed: Promise<void>;
}

const sftpPool = new Map<string, PooledClient>();

function poolKey(memberId: string, w: TerminalWorkspace & {kind:"ssh"}): string {
  return `${memberId}::${w.id}`;
}

async function getSftp(memberId: string, w: TerminalWorkspace & {kind:"ssh"}): Promise<any> {
  if (!memberRuntimeAllowed(memberId)) throw new Error("member runtime admission is closed");
  const key = poolKey(memberId,w);
  const existing = sftpPool.get(key);
  if (existing) {
    if (existing.failed) {
      existing.conn.destroy(); await awaitResourceClose(existing.closed,"SFTP connection");
      return getSftp(memberId,w);
    }
    await existing.ready;
    if (!memberRuntimeAllowed(memberId)) throw new Error("member runtime admission is closed");
    return existing.sftp;
  }
  const { Client } = await import("ssh2");
  if (!memberRuntimeAllowed(memberId)) throw new Error("member runtime admission is closed");
  if (sftpPool.has(key)) return getSftp(memberId,w);
  const conn = new Client();
  let resolveClosed!: () => void;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const entry: PooledClient = {
    conn, sftp: null, failed: false,
    closed: new Promise<void>(resolve => { resolveClosed = resolve; }),
    ready: new Promise<void>((resolve,reject) => { resolveReady = resolve; rejectReady = reject; }),
  };
  sftpPool.set(key,entry);
  const failed = (error: Error) => { entry.failed = true; rejectReady(error); conn.destroy(); };
  conn.on("ready", () => conn.sftp((error: Error | undefined,sftp: any) => {
    if (error) { failed(new Error(`sftp channel failed: ${error.message}`)); return; }
    entry.sftp = sftp; resolveReady();
  })).on("error", (error: Error) => failed(new Error(`ssh connection failed: ${error.message}`)))
    .on("close", () => {
      entry.failed = true; resolveClosed(); rejectReady(new Error("ssh connection closed"));
      if (sftpPool.get(key) === entry) sftpPool.delete(key);
    });
  try {
    conn.connect({host:w.host,port:w.port,username:w.user,privateKey:existsSync(w.keyPath)?readFileSync(w.keyPath):undefined});
  } catch (error) { failed(error as Error); }
  await entry.ready;
  if (!memberRuntimeAllowed(memberId)) throw new Error("member runtime admission is closed");
  return entry.sftp;
}

export async function dropSftpConnectionsForMember(memberId?: string): Promise<void> {
  const entries = [...sftpPool].filter(([key]) => memberId === undefined || key.startsWith(`${memberId}::`));
  for (const [,entry] of entries) entry.conn.destroy();
  await Promise.all(entries.map(([,entry]) => awaitResourceClose(entry.closed,"SFTP connection")));
}

function sftpReadFile(sftp: any, path: string): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", rejectPromise);
    stream.on("close", () => rejectPromise(new Error("SFTP read closed before completion")));
    stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
  });
}

function sftpWriteFile(sftp: any, path: string, data: Buffer, mkdirp: boolean): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    sftp.writeFile(path, data, (err: Error | undefined) => {
      if (!err) { resolvePromise(); return; }
      if (!mkdirp) { rejectPromise(err); return; }
      // mkdir -p the parent, then retry once
      const parent = path.split("/").slice(0, -1).join("/");
      sftp.mkdir(parent, (mkdirErr: Error | undefined) => {
        // ENOTDIR/EEXIST-style parents are tolerated by retrying blindly
        sftp.writeFile(path, data, (err2: Error | undefined) => {
          if (err2) rejectPromise(new Error(`${err2.message}${mkdirErr ? ` (after mkdir ${parent}: ${mkdirErr.message})` : ""}`));
          else resolvePromise();
        });
      });
    });
  });
}
async function sftpMkdirp(sftp: any, dir: string): Promise<void> {
  const parts = dir.split("/").filter(Boolean);
  let cur = dir.startsWith("/") ? "" : ".";
  for (const part of parts) {
    cur = `${cur}/${part}`.replace(/^\.\//, dir.startsWith("/") ? "" : "./");
    await new Promise<void>((resolvePromise) => {
      sftp.mkdir(cur, () => resolvePromise()); // EEXIST is fine
    });
  }
}

// ── tool implementations ──

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const MAX_READ_BYTES = 400 * 1024;
const MAX_EDIT_FILE_BYTES = 800 * 1024;

export interface FileToolResult {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown> = {}): FileToolResult {
  return { content: [{ type: "text", text }], details };
}

function toolError(message: string): FileToolResult {
  return textResult(`Failed: ${message}`);
}
async function readWorkspaceBytes(memberId:string,workspace:TerminalWorkspace,path:string,max:number):Promise<Buffer>{
  const bytes=workspace.kind==="original"?(()=>{if(!existsSync(path))throw new Error(`File not found: ${path}`);const stat=statSync(path);if(!stat.isFile())throw new Error(`Not a file: ${path}`);return readFileSync(path);})():await sftpReadFile(await getSftp(memberId,workspace),path);
  if(bytes.length>max)throw new Error(`File too large (${bytes.length} bytes > ${max})`);return bytes;
}
async function writeWorkspaceBytes(memberId:string,workspace:TerminalWorkspace,path:string,bytes:Buffer):Promise<void>{
  if(workspace.kind==="original"){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);return;}
  const sftp=await getSftp(memberId,workspace);await sftpMkdirp(sftp,dirname(path));await sftpWriteFile(sftp,path,bytes,false);
}

export async function workspaceReadTool(memberId: string, args: { path?: string; offset?: number; limit?: number; workspace?: string }): Promise<FileToolResult> {
  if (!memberRuntimeAllowed(memberId)) return toolError("member runtime admission is closed");
  const resolution = resolveWorkspacePath(memberId, String(args.path ?? ""), args.workspace);
  if ("error" in resolution) return toolError(resolution.error);
  const { workspace, path } = resolution;
  const offset = args.offset && args.offset > 0 ? Math.floor(args.offset) || 1 : 1;
  const limit = args.limit && args.limit > 0 ? Math.max(1, Math.floor(args.limit)) : undefined;
  try {
    const ext=path.slice(path.lastIndexOf(".")).toLowerCase(),image=workspace.kind==="original"&&IMAGE_EXTENSIONS.has(ext);
    const buf=await readWorkspaceBytes(memberId,workspace,path,image||workspace.kind==="ssh"?MAX_READ_BYTES:Number.MAX_SAFE_INTEGER);
    if(image){
      const mimeType=ext===".jpg"||ext===".jpeg"?"image/jpeg":ext===".png"?"image/png":ext===".gif"?"image/gif":ext===".webp"?"image/webp":"image/bmp";
      return {content:[{type:"image",data:buf.toString("base64"),mimeType}],details:{path,workspace:workspace.id,bytes:buf.length}};
    }
    const result = readTextOutput(buf.toString("utf-8"), path, offset, limit);
    return textResult(result.text, { path, workspace: workspace.id, ...result.details, ...(workspace.kind === "ssh" ? { remote: true } : {}) });
  } catch (err: any) {
    logger.warn("file-tools", "read failed", { memberId, workspace: workspace.id, path, error: String(err?.message || err) });
    return toolError(err?.message || String(err));
  }
}

export async function workspaceWriteTool(memberId: string, args: { path?: string; content?: string; workspace?: string }): Promise<FileToolResult> {
  if (!memberRuntimeAllowed(memberId)) return toolError("member runtime admission is closed");
  const resolution = resolveWorkspacePath(memberId, String(args.path ?? ""), args.workspace);
  if ("error" in resolution) return toolError(resolution.error);
  if (typeof args.content !== "string") return toolError("content is required");
  const { workspace, path } = resolution;
  try {
    const bytes=Buffer.from(args.content,"utf-8");await writeWorkspaceBytes(memberId,workspace,path,bytes);
    return textResult(`Wrote ${bytes.length} bytes to ${path}${workspace.kind==="ssh"?` (ssh:${workspace.id})`:""}`,{path,workspace:workspace.id,...(workspace.kind==="ssh"?{remote:true}:{})});
  } catch (err: any) {
    return toolError(err?.message || String(err));
  }
}
export async function workspaceEditTool(memberId: string, args: { path?: string; edits?: Array<{ oldText?: string; newText?: string }>; workspace?: string }): Promise<FileToolResult> {
  if (!memberRuntimeAllowed(memberId)) return toolError("member runtime admission is closed");
  const resolution = resolveWorkspacePath(memberId, String(args.path ?? ""), args.workspace);
  if ("error" in resolution) return toolError(resolution.error);
  const edits = Array.isArray(args.edits) ? args.edits : [];
  if (edits.length === 0) return toolError("edits array with at least one {oldText, newText} is required");
  for (const e of edits) {
    if (typeof e.oldText !== "string" || typeof e.newText !== "string") {
      return toolError("every edit needs oldText and newText strings");
    }
  }
  const { workspace, path } = resolution;
  try {
    let text=(await readWorkspaceBytes(memberId,workspace,path,MAX_EDIT_FILE_BYTES)).toString("utf-8");
    for (let i = 0; i < edits.length; i++) {
      const { oldText, newText } = edits[i];
      const occurrences = text.split(String(oldText)).length - 1;
      if (occurrences === 0) {
        return toolError(`Edit ${i + 1}: oldText not found in ${path}. The file may have changed — read it again.`);
      }
      if (occurrences > 1) {
        return toolError(`Edit ${i + 1}: oldText matches ${occurrences} times in ${path}. Include more surrounding lines to make it unique.`);
      }
      text = text.replace(String(oldText), String(newText));
    }

    await writeWorkspaceBytes(memberId,workspace,path,Buffer.from(text,"utf-8"));
    return textResult(`Applied ${edits.length} edit${edits.length > 1 ? "s" : ""} to ${path}`, { path, workspace: workspace.id });
  } catch (err: any) {
    return toolError(err?.message || String(err));
  }
}

// Agent tool callback handler — business logic for chat/messages/summary tools

export interface AgentToolHostInput {
  tool:string;params:Record<string,unknown>;memberId:string;currentSourceRef:string|null;
}
export type AgentToolHost=(input:AgentToolHostInput)=>Promise<unknown>|unknown;
let agentToolHost:AgentToolHost|undefined;
export function configureAgentToolHost(host:AgentToolHost|undefined):void{agentToolHost=host;}

export interface ToolExecutionContext {signal?:AbortSignal;memberId?:string}

/** Runtime-owned tools stay here. Cross-domain chat/member/workspace operations
 * cross one injected app port, so agent code never interprets chat identities. */
export async function handleToolCallback(
  tool:string,sourceRef:string,agentName:string,params:Record<string,any>,context?:ToolExecutionContext,
):Promise<unknown>{
  const memberId=context?.memberId||agentName;
  if(!memberId)return {ok:false,error:"A trusted member ID is required",code:"invalid_caller"};
  logger.info("callback","tool-callback",{tool,sourceRef:sourceRef||null,memberId});
  if(tool==="read")return workspaceReadTool(memberId,params||{});
  if(tool==="write")return workspaceWriteTool(memberId,params||{});
  if(tool==="edit")return workspaceEditTool(memberId,params||{});
  if(tool==="terminal_create")return createShell({memberId,name:params?.name?String(params.name):undefined,workspace:params?.workspace?String(params.workspace):undefined,cwd:params?.cwd?String(params.cwd):undefined});
  if(tool==="terminal_exec")return execInShell({signal:context?.signal,memberId,shell:String(params?.terminalId||""),command:params?.command===undefined?undefined:String(params.command),keys:params?.keys===undefined?undefined:String(params.keys),blockUntilMs:params?.blockSeconds===undefined?undefined:Math.round(Number(params.blockSeconds)*1000)});
  if(tool==="terminal_read"){
    const result=readShell({memberId,shell:String(params?.terminalId||""),exec:params?.exec?String(params.exec):undefined,fromLine:params?.fromLine===undefined?undefined:Number(params.fromLine),toLine:params?.toLine===undefined?undefined:Number(params.toLine)});
    return result.ok?{ok:true,status:result.status,exitCode:result.exitCode,lineStart:result.lineStart,lineEnd:result.lineEnd,truncated:result.truncated,lines:result.lines.map(line=>`${line.n}: ${line.text}`)}:result;
  }
  if(tool==="terminal_wait")return waitShell({signal:context?.signal,memberId,shell:String(params?.terminalId||""),exec:String(params?.exec||""),blockUntilMs:params?.blockSeconds===undefined?undefined:Math.round(Number(params.blockSeconds)*1000)});
  if(tool==="terminal_list")return {ok:true,terminals:listShells(memberId)};
  if(tool==="terminal_close")return closeShell(memberId,String(params?.terminalId||""));
  if(tool==="reload"){
    const {reloadMemberSession}=await import("./assembly.js");
    const result=await reloadMemberSession(memberId,"tool");
    return {ok:true,...result,message:result.queued?"Session rebuild queued until this turn finishes; history is preserved.":"Session rebuilt with fresh member assets; history is preserved."};
  }
  if(!agentToolHost)return {ok:false,error:"Agent tools are not connected"};
  return agentToolHost({tool,params,memberId,currentSourceRef:sourceRef||null});
}
