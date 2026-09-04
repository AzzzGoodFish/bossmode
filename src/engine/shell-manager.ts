/**
 * Batch 7 P2 (spec-batch7-workspace-shell-impl-v1 §3-§4): persistent member
 * shells. A shell is a real PTY (node-pty locally, an ssh2 channel for ssh
 * workspaces) — cwd/env/long-running processes survive across tool calls.
 * Members own their shells (cross-scope); state is memory-only — a daemon
 * restart empties the list and stale references fail honestly.
 *
 * Completion protocol (fish: no command wrapping): the shell init sets
 * `stty -echo`, an empty PS1, and appends an OSC 133;D marker to
 * PROMPT_COMMAND — invisible, never enters history, carries the exit code.
 * Output is captured as a byte stream (nothing lost), lines are numbered, and
 * shell_read accepts an exec id or a line range. Commands that outlive
 * blockUntilMs (default 10s) return as running; read collects the rest later.
 * Known limit (documented in guide): a nested shell inside a shell does not
 * emit markers — the outer exec stays "running" until it returns.
 */
import { getWorkspace, type SshWorkspace } from "../workspace/workspace-registry.js";
import { logger } from "../foundation/logger.js";

export const SHELL_COLS = 160;
export const SHELL_ROWS = 1000;
export const BLOCK_UNTIL_MS_DEFAULT = 10_000;
const RING_MAX_LINES = 10_000;
const OSC_133_D = /\x1b\]133;D;(\d*)(?:;([^\x07\x1b]*))?\x07|\x1b\]133;D;(\d*)(?:;([^\x07\x1b]*))?\x1b\\/g;

interface ShellExec {
  id: string;
  lineStart: number;
  lineEnd: number | null;
  exitCode: number | null;
  output: string;
  status: "running" | "done";
  resolve?: () => void;
  /** Settles when the exec reaches done — shell_wait blocks on this. */
  done: Promise<void>;
  doneResolve: () => void;
}

interface PendingWrite {
  command?: string;
  keys?: string;
}

interface LiveShell {
  id: string;
  name?: string;
  memberId: string;
  workspaceId: string;
  cwd?: string;
  proc: { write(data: string): void; kill(signal?: string): void; on(ev: string, fn: (arg: any) => void): void };
  alive: boolean;
  execCounter: number;
  lines: string[];
  firstLine: number; // absolute number of lines[0]
  lineCount: number; // absolute next line number
  pendingMarker: boolean;
  carry: string; // partial OSC/escape sequence split across data chunks
  lastCwd?: string; // last cwd reported by the completion marker (receipt base)
  currentExec: ShellExec | null;
  execHistory: ShellExec[]; // finished execs (capped) so shell_read can close them out
  writeQueue: Array<PendingWrite & { exec?: ShellExec }>;
  draining: boolean;
  sshClient?: any; // kept so close() can tear the whole connection
}

const shells = new Map<string, LiveShell>(); // key: memberId::shellId

// Per-member blocking shell_exec waits — settled by interrupt so the tool
// returns running (with its exec id) immediately instead of holding the
// member's abort until the command/timeout ends (qa rc.22 note ①).
const memberShellWaits = new Map<string, Set<() => void>>();

function registerMemberShellWait(memberId: string, settle: () => void): () => void {
  let set = memberShellWaits.get(memberId);
  if (!set) {
    set = new Set();
    memberShellWaits.set(memberId, set);
  }
  set.add(settle);
  return () => {
    set!.delete(settle);
    if (set!.size === 0) memberShellWaits.delete(memberId);
  };
}

/** Interrupt support: end every blocking shell_exec wait for this member now.
 * Each race resolves as running — the command itself keeps going in the PTY. */
export function settleMemberShellWaits(memberId: string): void {
  const set = memberShellWaits.get(memberId);
  if (!set) return;
  const fns = [...set];
  set.clear();
  memberShellWaits.delete(memberId);
  for (const fn of fns) fn();
}

function shellKey(memberId: string, shellId: string): string {
  return `${memberId}::${shellId}`;
}

function newShellId(): string {
  return `s${(++shellIdCounter).toString(36)}`;
}
let shellIdCounter = 0;

function initSequence(): string {
  // -echo: the command we write must not be echoed back as "output".
  // Empty PS1: no prompt text between commands. The marker printf is APPENDED
  // (not replacing) so prompt frameworks keep working until they replace it.
  return `stty -echo; export PS1=''; PROMPT_COMMAND="printf '\\\\033]133;D;%s;%s\\\\007' \\"\\$?\\" \\"\\$PWD\\"; \${PROMPT_COMMAND:-}"\n`;
}

function stripOsc(text: string): { text: string; markers: Array<{ exitCode: number | null; cwd: string | null; index: number }> } {
  const markers: Array<{ exitCode: number | null; cwd: string | null; index: number }> = [];
  OSC_133_D.lastIndex = 0;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC_133_D.exec(text)) !== null) {
    const code = m[1] ?? m[3];
    const cwdField = m[2] ?? m[4];
    markers.push({
      exitCode: code !== undefined && code !== "" ? Number(code) : null,
      cwd: cwdField !== undefined && cwdField !== "" ? cwdField : null,
      index: m.index,
    });
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
  }
  out += text.slice(last);
  return { text: out, markers };
}

const CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const OSC_ANY_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function pushData(shell: LiveShell, raw: string): void {
  // Chunk-safe: append to carry, keep a trailing partial escape for the next chunk.
  let buffer = shell.carry + raw;
  shell.carry = "";
  const { text, markers } = stripOsc(buffer);
  let clean = text.replace(OSC_ANY_RE, "").replace(CSI_RE, "");
  // if the tail looks like a partial escape sequence, hold it back
  const lastEsc = clean.lastIndexOf("\x1b");
  if (lastEsc !== -1 && clean.length - lastEsc < 24 && !/[\x07\n]/.test(clean.slice(lastEsc))) {
    shell.carry = clean.slice(lastEsc);
    clean = clean.slice(0, lastEsc);
  }
  const newLines = clean.split("\n");
  const first = newLines.shift() ?? "";
  // append the head fragment to the last buffered line
  if (shell.lines.length > 0) {
    shell.lines[shell.lines.length - 1] += first;
  } else {
    if (first !== "") shell.lines.push(first);
  }
  for (const line of newLines) shell.lines.push(line);
  while (shell.lines.length > RING_MAX_LINES) {
    shell.lines.shift();
    shell.firstLine++;
  }
  shell.lineCount = shell.firstLine + shell.lines.length;
  if (shell.currentExec && clean.length > 0) shell.currentExec.output += clean;
  for (const marker of markers) {
    // cwd receipt (fish 2026-09-04): every completion marker carries $PWD; when
    // it changes the exec result (and the line stream) gets one receipt line.
    // The first marker after shell birth just records the baseline silently.
    if (marker.cwd) {
      if (shell.lastCwd && shell.lastCwd !== marker.cwd) {
        const receipt = `cwd: ${shell.lastCwd} → ${marker.cwd}`;
        shell.lines.push(receipt);
        shell.lineCount = shell.firstLine + shell.lines.length;
        if (shell.currentExec) {
          shell.currentExec.output += `${shell.currentExec.output.endsWith("\n") || shell.currentExec.output === "" ? "" : "\n"}${receipt}\n`;
        }
      }
      shell.lastCwd = marker.cwd;
      if (shell.cwd !== marker.cwd) shell.cwd = marker.cwd;
    }
    if (shell.currentExec) {
      const exec = shell.currentExec;
      exec.status = "done";
      exec.exitCode = marker.exitCode;
      exec.lineEnd = Math.max(shell.lineCount - 2, exec.lineStart); // last written line (lineCount counts the trailing empty line)
      shell.currentExec = null;
      exec.resolve?.();
      exec.resolve = undefined;
      exec.doneResolve?.();
      archiveExec(shell, exec);
    }
    shell.pendingMarker = false;
    drainQueue(shell);
  }
}

function archiveExec(shell: LiveShell, exec: ShellExec): void {
  shell.execHistory.push(exec);
  if (shell.execHistory.length > 100) shell.execHistory.shift();
}

function drainQueue(shell: LiveShell): void {
  if (shell.draining || shell.currentExec || !shell.alive) return;
  // Marker gating: never write the next line until the previous one's
  // completion marker arrived (serializes execs; the init sequence's own
  // marker must close before the first command runs).
  if (shell.pendingMarker) return;
  const next = shell.writeQueue.shift();
  if (!next) return;
  shell.draining = true;
  try {
    if (next.exec) {
      shell.currentExec = next.exec;
      shell.pendingMarker = true;
      shell.proc.write(`${next.command}\n`);
    } else if (next.keys !== undefined) {
      shell.proc.write(next.keys);
    } else if (next.command !== undefined) {
      shell.pendingMarker = true;
      shell.proc.write(`${next.command}\n`);
    }
  } finally {
    shell.draining = false;
  }
}

async function spawnLocalShell(memberId: string, workspaceId: string, cwd: string | undefined, id: string, name: string | undefined): Promise<LiveShell> {
  const pty = await import("node-pty");
  // Always a real, bare bash (spec §4): PROMPT_COMMAND is the completion
  // protocol and prompt frameworks (zsh/oh-my-zsh, starship) replace it.
  // --norc --noprofile keeps the marker guaranteed; members bring their own
  // environment via commands if they want it.
  const proc = pty.spawn("/bin/bash", ["--norc", "--noprofile"], {
    name: "xterm-256color",
    cols: SHELL_COLS,
    rows: SHELL_ROWS,
    cwd: cwd && cwd !== "." ? cwd : undefined,
    env: {
      // Clean env: do NOT inherit the daemon process environment (OpenBot
      // lesson — `env` would print daemon secrets).
      HOME: process.env.HOME,
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TERM: "xterm-256color",
      LANG: process.env.LANG || "en_US.UTF-8",
    } as Record<string, string>,
  });
  const shell: LiveShell = {
    id, name, memberId, workspaceId, cwd,
    proc: proc as unknown as LiveShell["proc"],
    alive: true, execCounter: 0,
    lines: [], firstLine: 1, lineCount: 1,
    pendingMarker: false, carry: "", currentExec: null, writeQueue: [], draining: false,
    execHistory: [],
  };
  proc.onData((data: string) => pushData(shell, data));
  proc.onExit(() => {
    shell.alive = false;
    if (shell.currentExec) {
      const exec = shell.currentExec;
      exec.status = "done";
      exec.exitCode = null;
      exec.lineEnd = Math.max(shell.lineCount - 2, exec.lineStart);
      shell.currentExec = null;
      exec.resolve?.();
      exec.resolve = undefined;
      exec.doneResolve?.();
      archiveExec(shell, exec);
    }
    drainQueue(shell);
  });
  // init sequence as the very first queued write
  shell.writeQueue.push({ command: initSequence().trimEnd() });
  drainQueue(shell);
  return shell;
}

async function spawnSshShell(memberId: string, workspace: SshWorkspace, cwd: string | undefined, id: string, name: string | undefined): Promise<LiveShell> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { Client } = await import("ssh2");
  const conn = new Client();
  await new Promise<void>((resolve, reject) => {
    conn
      .on("ready", () => resolve())
      .on("error", (err: Error) => reject(new Error(`ssh connection failed: ${err.message}`)))
      .connect({
        host: workspace.host,
        port: workspace.port,
        username: workspace.user,
        privateKey: existsSync(workspace.keyPath) ? readFileSync(workspace.keyPath) : undefined,
      });
  });
  const channel = await new Promise<any>((resolve, reject) => {
    conn.shell({ term: "xterm-256color", cols: SHELL_COLS, rows: SHELL_ROWS }, (err: Error | undefined, stream: any) => {
      if (err) reject(new Error(`ssh shell failed: ${err.message}`));
      else resolve(stream);
    });
  });
  const shell: LiveShell = {
    id, name, memberId, workspaceId: workspace.id, cwd,
    proc: {
      write: (data: string) => channel.write(data),
      kill: () => { try { channel.close(); } catch { /* already gone */ } try { conn.end(); } catch { /* already gone */ } },
      on: (ev: string, fn: (arg: any) => void) => {
        if (ev === "data") channel.on("data", (d: Buffer) => fn(d.toString("utf-8")));
        if (ev === "exit") channel.on("close", () => fn(undefined));
      },
    },
    alive: true, execCounter: 0,
    lines: [], firstLine: 1, lineCount: 1,
    pendingMarker: false, carry: "", currentExec: null, writeQueue: [], draining: false,
    execHistory: [],
    sshClient: conn,
  };
  channel.on("data", (d: Buffer) => pushData(shell, d.toString("utf-8")));
  channel.on("close", () => {
    shell.alive = false;
    if (shell.currentExec) {
      const exec = shell.currentExec;
      exec.status = "done";
      exec.exitCode = null;
      exec.lineEnd = Math.max(shell.lineCount - 2, exec.lineStart);
      shell.currentExec = null;
      exec.resolve?.();
      exec.resolve = undefined;
      exec.doneResolve?.();
    }
    drainQueue(shell);
  });
  shell.writeQueue.push({ command: initSequence().trimEnd() });
  drainQueue(shell);
  return shell;
}

export type ShellCreateResult = { ok: true; shell: string; workspace: string; cwd: string } | { ok: false; error: string };

export async function createShell(args: {
  memberId: string;
  name?: string;
  workspace?: string;
  cwd?: string;
}): Promise<ShellCreateResult> {
  const ws = args.workspace ? getWorkspace(args.memberId, args.workspace) : undefined;
  if (args.workspace && !ws) {
    return { ok: false, error: `Workspace not found: ${args.workspace}` };
  }
  const workspace = ws ?? (await import("../workspace/workspace-registry.js")).getActiveWorkspace(args.memberId);
  const id = newShellId();
  try {
    let shell: LiveShell;
    if (workspace.kind === "ssh") {
      const cwd = args.cwd?.trim() || workspace.root;
      shell = await spawnSshShell(args.memberId, workspace, cwd, id, args.name);
    } else {
      const cwd = args.cwd?.trim() || workspace.root;
      shell = await spawnLocalShell(args.memberId, workspace.id, cwd, id, args.name);
    }
    shells.set(shellKey(args.memberId, id), shell);
    logger.info("shell-manager", "shell created", { memberId: args.memberId, shell: id, workspace: workspace.id });
    return { ok: true, shell: id, workspace: workspace.id, cwd: args.cwd?.trim() || (workspace.kind === "ssh" ? workspace.root : workspace.root) };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

export type ShellExecResult =
  | { ok: true; exec: string; status: "done"; exitCode: number | null; lineStart: number; lineEnd: number; output: string }
  | { ok: true; exec: string; status: "running"; lineStart: number; outputSoFar: string; note: string }
  | { ok: false; error: string };

const KEY_SEQUENCES: Record<string, string> = {
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-z": "\x1a",
};

export async function execInShell(args: {
  memberId: string;
  shell: string;
  command?: string;
  keys?: string;
  blockUntilMs?: number;
}): Promise<ShellExecResult> {
  const shell = shells.get(shellKey(args.memberId, args.shell));
  if (!shell) {
    return { ok: false, error: `Shell not found: ${args.shell}. It may have been closed, or the daemon restarted (shells are memory-only — create a new one).` };
  }
  if (!shell.alive) {
    return { ok: false, error: `Shell ${args.shell} is dead (process exited). Create a new one with shell_create.` };
  }
  if (args.keys !== undefined) {
    const seq = KEY_SEQUENCES[args.keys];
    if (!seq) {
      return { ok: false, error: `Unknown keys: ${args.keys}. Supported: ${Object.keys(KEY_SEQUENCES).join(", ")}.` };
    }
    if (shell.currentExec) {
      // interrupt the running exec — it will close on the next marker/timeout
      shell.proc.write(seq);
      return { ok: true, exec: shell.currentExec.id, status: "running", lineStart: shell.currentExec.lineStart, outputSoFar: shell.currentExec.output, note: `Sent ${args.keys}.` };
    }
    shell.writeQueue.push({ keys: seq });
    drainQueue(shell);
    return { ok: true, exec: "e0", status: "done", exitCode: null, lineStart: shell.lineCount, lineEnd: shell.lineCount, output: `Sent ${args.keys}.` };
  }
  if (typeof args.command !== "string" || !args.command.trim()) {
    return { ok: false, error: "command is required (or use keys to send a control key)." };
  }

  const exec = {
    id: `e${++shell.execCounter}`,
    lineStart: shell.lineCount,
    lineEnd: null,
    exitCode: null,
    output: "",
    status: "running",
  } as ShellExec;
  const done = new Promise<void>((resolve) => { exec.resolve = resolve; });
  exec.done = new Promise<void>((resolve) => { exec.doneResolve = resolve; });
  shell.writeQueue.push({ command: args.command, exec });
  drainQueue(shell);

  const blockMs = args.blockUntilMs !== undefined && args.blockUntilMs >= 0 ? args.blockUntilMs : BLOCK_UNTIL_MS_DEFAULT;
  const timer = blockMs > 0 ? setTimeout(() => {}, blockMs) : null; // keep the event loop honest in tests
  let settled = false;
  // Abort settle (qa rc.22 note ①): a blocking wait must end the moment the
  // member is interrupted — settleMemberShellWaits resolves this race as
  // running instead of holding the abort hostage until the command/timeout
  // finishes.
  const waitReg: { unregister?: () => void } = {};
  const raced = await Promise.race([
    done.then(() => true),
    blockMs > 0
      ? new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), blockMs);
          waitReg.unregister = registerMemberShellWait(args.memberId, () => {
            clearTimeout(t);
            resolve(false);
          });
        })
      : Promise.resolve(false), // 0 = never block (qa rc.20 Major: a never-resolving promise here turned "background immediately" into a hang)
  ]);
  waitReg.unregister?.();
  settled = raced;
  if (timer) clearTimeout(timer);

  if (settled && exec.status === "done") {
    return { ok: true, exec: exec.id, status: "done", exitCode: exec.exitCode, lineStart: exec.lineStart, lineEnd: exec.lineEnd ?? exec.lineStart, output: exec.output };
  }
  return {
    ok: true,
    exec: exec.id,
    status: "running",
    lineStart: exec.lineStart,
    outputSoFar: exec.output,
    note: `Still running after ${blockMs}ms — collect output later with shell_read, or wait for completion with shell_wait (shell ${args.shell}, exec ${exec.id}). Nested shells do not emit completion markers.`,
  };
}

export type ShellReadResult =
  | { ok: true; status: "running" | "done"; exitCode: number | null; lineStart: number; lineEnd: number; lines: Array<{ n: number; text: string }>; truncated: boolean }
  | { ok: false; error: string };

export function readShell(args: {
  memberId: string;
  shell: string;
  exec?: string;
  fromLine?: number;
  toLine?: number;
}): ShellReadResult {
  const shell = shells.get(shellKey(args.memberId, args.shell));
  if (!shell) {
    return { ok: false, error: `Shell not found: ${args.shell} (shells are memory-only — a daemon restart clears them).` };
  }
  let from: number;
  let to: number | undefined;
  let status: "running" | "done";
  if (args.exec) {
    const current = shell.currentExec?.id === args.exec ? shell.currentExec : null;
    const finished = current ? null : shell.execHistory.find((e) => e.id === args.exec) ?? null;
    if (current) {
      from = current.lineStart;
      to = shell.lineCount;
      status = "running";
    } else if (finished) {
      from = finished.lineStart;
      to = finished.lineEnd ?? shell.lineCount;
      status = "done";
      return {
        ok: true,
        status,
        exitCode: finished.exitCode,
        lineStart: from,
        lineEnd: to,
        lines: sliceLines(shell, from, to),
        truncated: false,
      };
    } else {
      return { ok: false, error: `Exec ${args.exec} not found on shell ${args.shell}. Use shell_read with a line range, or the exec may still be queued.` };
    }
  } else {
    from = args.fromLine && args.fromLine > 0 ? args.fromLine : shell.firstLine;
    to = args.toLine && args.toLine >= from ? args.toLine : undefined;
    status = shell.alive && shell.currentExec ? "running" : "done";
  }
  const lastAvailable = Math.max(shell.lineCount - 1, shell.firstLine); // last complete line
  const end = Math.min(to ?? lastAvailable, lastAvailable);
  return {
    ok: true,
    status,
    exitCode: shell.currentExec?.exitCode ?? null,
    lineStart: from,
    lineEnd: end,
    lines: sliceLines(shell, from, end),
    truncated: end < lastAvailable,
  };
}

function sliceLines(shell: LiveShell, from: number, to: number): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  for (let n = from; n <= to; n++) {
    const idx = n - shell.firstLine;
    if (idx < 0 || idx >= shell.lines.length) continue;
    out.push({ n, text: shell.lines[idx] });
  }
  return out;
}

/** Interrupt synthesis support (design-interrupt-on-message-v1): the shell's
 * still-running exec, if any — used to tell the member which exec id to
 * collect with shell_read after being interrupted. */
export function getShellPendingExec(memberId: string, shellId: string): { exec: string } | null {
  const shell = shells.get(shellKey(memberId, shellId));
  if (!shell) return null;
  if (shell.currentExec) return { exec: shell.currentExec.id };
  const queued = shell.writeQueue.find((w) => w.exec)?.exec;
  if (queued) return { exec: queued.id };
  return null;
}

/** Design-interrupt-on-message-v1.1: shell_wait — block until an exec is done
 * (or the wait budget runs out). Default 30s; blockUntilMs 0 waits forever.
 * Done returns exit code + line range + output; a timeout returns running with
 * the progress so far. shell_read stays an instant snapshot. */
export async function waitShell(args: {
  memberId: string;
  shell: string;
  exec: string;
  blockUntilMs?: number;
}): Promise<
  | { ok: true; exec: string; status: "done"; exitCode: number | null; lineStart: number; lineEnd: number; output: string }
  | { ok: true; exec: string; status: "running"; outputSoFar: string; note: string }
  | { ok: false; error: string }
> {
  const shell = shells.get(shellKey(args.memberId, args.shell));
  if (!shell) {
    return { ok: false, error: `Shell not found: ${args.shell}. It may have been closed, or the daemon restarted (shells are memory-only — create a new one).` };
  }
  const queued = shell.writeQueue.find((w) => w.exec?.id === args.exec)?.exec;
  const exec = (shell.currentExec?.id === args.exec ? shell.currentExec : undefined)
    ?? queued
    ?? shell.execHistory.find((e) => e.id === args.exec);
  if (!exec) {
    return { ok: false, error: `Exec not found: ${args.exec} on shell ${args.shell}. Use shell_list to see the shell's execs.` };
  }
  const respond = () => exec.status === "done"
    ? { ok: true as const, exec: exec.id, status: "done" as const, exitCode: exec.exitCode, lineStart: exec.lineStart, lineEnd: exec.lineEnd ?? exec.lineStart, output: exec.output }
    : { ok: true as const, exec: exec.id, status: "running" as const, outputSoFar: exec.output, note: `Still running — wait again with shell_wait, or snapshot with shell_read.` };
  if (exec.status === "done") return respond();
  const blockMs = args.blockUntilMs !== undefined && args.blockUntilMs >= 0 ? args.blockUntilMs : 30_000;
  if (blockMs === 0) {
    await exec.done;
  } else {
    await Promise.race([exec.done, new Promise<void>((resolve) => setTimeout(resolve, blockMs))]);
  }
  return respond();
}

export function listShells(memberId: string): Array<{ id: string; name?: string; workspace: string; running: string | null; alive: boolean; lines: number }> {
  const out = [];
  for (const shell of shells.values()) {
    if (shell.memberId !== memberId) continue;
    out.push({
      id: shell.id,
      name: shell.name,
      workspace: shell.workspaceId,
      running: shell.currentExec?.id ?? null,
      alive: shell.alive,
      lines: shell.lines.length,
    });
  }
  return out;
}

export function closeShell(memberId: string, shellId: string): { ok: true } | { ok: false; error: string } {
  const key = shellKey(memberId, shellId);
  const shell = shells.get(key);
  if (!shell) return { ok: false, error: `Shell not found: ${shellId}` };
  if (shell.currentExec) {
    shell.currentExec.status = "done";
    shell.currentExec.exitCode = null;
    shell.currentExec.resolve?.();
    shell.currentExec.resolve = undefined;
    shell.currentExec = null;
  }
  try { shell.proc.kill(); } catch { /* already gone */ }
  if (shell.sshClient) { try { shell.sshClient.end(); } catch { /* already gone */ } }
  shells.delete(key);
  logger.info("shell-manager", "shell closed", { memberId, shell: shellId });
  return { ok: true };
}

/** P1 file-tools sftp pool teardown shares this on member destruction. */
export function closeAllShellsForMember(memberId: string): void {
  for (const [key, shell] of [...shells.entries()]) {
    if (shell.memberId !== memberId) continue;
    try { shell.proc.kill(); } catch { /* already gone */ }
    if (shell.sshClient) { try { shell.sshClient.end(); } catch { /* already gone */ } }
    shells.delete(key);
  }
}
