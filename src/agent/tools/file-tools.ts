import {awaitResourceClose} from "../terminal.js";
import {memberRuntimeAllowed} from "../instance.js";
/**
 * Batch 7 P1 (spec §3): workspace-aware file tools — read/write/edit override
 * pi's built-ins by name (the SDK tool registry lets custom tools shadow
 * built-ins). Relative paths resolve against the active workspace root; the
 * optional `workspace` parameter picks a workspace by id. original = whole
 * local machine, no fence (fish: 整机不限制); ssh workspaces read/write over
 * sftp with a cached connection per workspace.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getWorkspace, getActiveWorkspace, type WorkspaceEntry, type SshWorkspace } from "../../member/workspaces.js";
import { logger } from "../../kernel/logger.js";

export interface WorkspacePathResolution {
  workspace: WorkspaceEntry;
  /** For original: an absolute local path. For ssh: a remote path (may be relative to the workspace root). */
  path: string;
}

export function resolveWorkspacePath(memberId: string, rawPath: string, workspaceId?: string): WorkspacePathResolution | { error: string } {
  if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
    return { error: "path is required" };
  }
  const p = rawPath.trim();
  const workspace = workspaceId ? getWorkspace(memberId, workspaceId) : getActiveWorkspace(memberId);
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

function poolKey(memberId: string, w: SshWorkspace): string {
  return `${memberId}::${w.id}`;
}

async function getSftp(memberId: string, w: SshWorkspace): Promise<any> {
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

export async function workspaceReadTool(memberId: string, args: { path?: string; offset?: number; limit?: number; workspace?: string }): Promise<FileToolResult> {
  if (!memberRuntimeAllowed(memberId)) return toolError("member runtime admission is closed");
  const resolution = resolveWorkspacePath(memberId, String(args.path ?? ""), args.workspace);
  if ("error" in resolution) return toolError(resolution.error);
  const { workspace, path } = resolution;
  const offset = args.offset && args.offset > 0 ? args.offset : 1;
  const limit = args.limit && args.limit > 0 ? args.limit : 2000;
  try {
    if (workspace.kind === "original") {
      if (!existsSync(path)) return toolError(`File not found: ${path}`);
      const stat = statSync(path);
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      if (!stat.isFile()) return toolError(`Not a file: ${path}`);
      if (IMAGE_EXTENSIONS.has(ext) && stat.size <= MAX_READ_BYTES) {
        const data = readFileSync(path).toString("base64");
        const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/bmp";
        return { content: [{ type: "image", data, mimeType }], details: { path, workspace: workspace.id, bytes: stat.size } };
      }
      const text = readFileSync(path, "utf-8");
      const lines = text.split("\n");
      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      const truncatedNote = offset - 1 + limit < lines.length ? `\n[${sliced.length} of ${lines.length} lines shown — pass offset=${offset + limit} for more]` : "";
      return textResult(sliced.join("\n") + truncatedNote, { path, workspace: workspace.id, lines: Math.min(sliced.length, lines.length) });
    }
    // ssh
    const sftp = await getSftp(memberId, workspace);
    const buf = await sftpReadFile(sftp, path);
    if (buf.length > MAX_READ_BYTES) {
      return toolError(`File too large to read remotely (${buf.length} bytes > ${MAX_READ_BYTES}). Copy it locally, or use a terminal on that workspace to read it in chunks.`);
    }
    const lines = buf.toString("utf-8").split("\n");
    const sliced = lines.slice(offset - 1, offset - 1 + limit);
    return textResult(sliced.join("\n"), { path, workspace: workspace.id, remote: true });
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
    if (workspace.kind === "original") {
      mkdirSync(dirname(path), { recursive: true });
      const existed = existsSync(path);
      writeFileSync(path, args.content, "utf-8");
      // Preserve exec bit when overwriting an executable file.
      if (existed) {
        try { const st = statSync(path); if (st.mode & 0o111) chmodSync(path, st.mode); } catch { /* best effort */ }
      }
      return textResult(`Wrote ${Buffer.byteLength(args.content, "utf-8")} bytes to ${path}`, { path, workspace: workspace.id });
    }
    const sftp = await getSftp(memberId, workspace);
    await sftpMkdirp(sftp, dirname(path));
    await sftpWriteFile(sftp, path, Buffer.from(args.content, "utf-8"), false);
    return textResult(`Wrote ${Buffer.byteLength(args.content, "utf-8")} bytes to ${path} (ssh:${workspace.id})`, { path, workspace: workspace.id, remote: true });
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
    let text: string;
    if (workspace.kind === "original") {
      if (!existsSync(path)) return toolError(`File not found: ${path}`);
      const stat = statSync(path);
      if (!stat.isFile()) return toolError(`Not a file: ${path}`);
      if (stat.size > MAX_EDIT_FILE_BYTES) return toolError(`File too large for edit (${stat.size} bytes > ${MAX_EDIT_FILE_BYTES})`);
      text = readFileSync(path, "utf-8");
    } else {
      const sftp = await getSftp(memberId, workspace);
      const buf = await sftpReadFile(sftp, path);
      if (buf.length > MAX_EDIT_FILE_BYTES) return toolError(`File too large for edit (${buf.length} bytes)`);
      text = buf.toString("utf-8");
    }

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

    if (workspace.kind === "original") {
      writeFileSync(path, text, "utf-8");
    } else {
      const sftp = await getSftp(memberId, workspace);
      await sftpWriteFile(sftp, path, Buffer.from(text, "utf-8"), false);
    }
    return textResult(`Applied ${edits.length} edit${edits.length > 1 ? "s" : ""} to ${path}`, { path, workspace: workspace.id });
  } catch (err: any) {
    return toolError(err?.message || String(err));
  }
}
