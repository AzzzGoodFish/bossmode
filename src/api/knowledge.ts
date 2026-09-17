// Knowledge API — single-namespace document management (0.8.0)
// ===============================================================
// All docs live under the single global tree at
// ~/.bossmode/knowledge/docs/. There is no KB container concept.

import { existsSync, statSync } from "node:fs";
import { addRoute, sendJson, parseBody } from "./index.js";
import * as knowledgeStore from "../knowledge/store.js";
import * as roomStore from "../chat/conversations.js";
import { logger } from "../kernel/logger.js";

function detectPathType(path: string): "file" | "folder" | null {
  try {
    const rel = knowledgeStore._internal.normalizeDocPath(path);
    const abs = knowledgeStore._internal.absDocPath(rel);
    if (!existsSync(abs)) return null;
    const st = statSync(abs);
    return st.isDirectory() ? "folder" : "file";
  } catch {
    return null;
  }
}

function inferTargetPath(from: string, to: string): string {
  // if destination is an existing folder path, preserve source basename
  const toType = detectPathType(to);
  if (toType !== "folder") return to;
  const base = from.split("/").pop() || from;
  return `${to}/${base}`;
}

function moveOne(from: string, to: string): { ok: boolean; type?: "file" | "folder"; to?: string; error?: string } {
  const sourceType = detectPathType(from);
  if (!sourceType) return { ok: false, error: "Source not found" };
  const resolvedTo = inferTargetPath(from, to);

  if (sourceType === "file") {
    const moved = knowledgeStore.moveEntry(from, resolvedTo);
    if (!moved) return { ok: false, error: "Source not found or destination conflicts" };
    const affected = roomStore.updateRuleDocPaths(from, moved.id);
    if (affected > 0) {
      logger.info("knowledge-api", "updated room ruleDocs refs after move", {
        from,
        to: moved.id,
        affectedRooms: affected,
      });
    }
    return { ok: true, type: "file", to: moved.id };
  }

  const movedFolder = knowledgeStore.moveFolder(from, resolvedTo);
  if (!movedFolder.ok) {
    return { ok: false, error: movedFolder.error || "Folder move failed" };
  }

  const affected = roomStore.updateRuleDocPathsByPrefix(from, resolvedTo);
  if (affected > 0) {
    logger.info("knowledge-api", "updated room ruleDocs refs after folder move", {
      from,
      to: resolvedTo,
      affectedRooms: affected,
      movedFiles: movedFolder.movedFiles.length,
    });
  }

  return { ok: true, type: "folder", to: resolvedTo };
}

function deleteOne(path: string): { ok: boolean; type?: "file" | "folder"; error?: string } {
  const type = detectPathType(path);
  if (!type) return { ok: false, error: "Document not found" };

  if (type === "file") {
    if (!knowledgeStore.deleteEntry(path)) return { ok: false, error: "Document not found" };
    const affected = roomStore.updateRuleDocPaths(path);
    if (affected > 0) {
      logger.info("knowledge-api", "updated room ruleDocs refs after delete", { path, affectedRooms: affected });
    }
    return { ok: true, type: "file" };
  }

  const result = knowledgeStore.deleteFolder(path);
  if (!result.ok) return { ok: false, error: "Folder not found" };
  for (const deletedPath of result.deletedPaths) {
    roomStore.updateRuleDocPaths(deletedPath);
  }
  return { ok: true, type: "folder" };
}

// -- Tree + flat list --

addRoute("GET", "/api/knowledge/tree", async (_req, res) => {
  sendJson(res, 200, knowledgeStore.getDocumentTree());
});

addRoute("GET", "/api/knowledge/entries", async (_req, res) => {
  const entries = knowledgeStore.listEntries().map((e) => ({
    id: e.id,
    title: e.title,
    source: e.source,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }));
  sendJson(res, 200, entries);
});

// -- Write --

addRoute("POST", "/api/knowledge/entries", async (req, res) => {
  const body = (await parseBody(req)) as {
    title?: string; content?: string; path?: string; source?: string;
  };
  if (!body.title || body.content === undefined) {
    sendJson(res, 400, { error: "title and content are required" });
    return;
  }
  try {
    const entry = knowledgeStore.addEntry(
      body.title, body.content,
      body.source || "user",
      body.path,
    );
    sendJson(res, 200, entry);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

// -- Single-doc read / update / delete (path via query string) --

addRoute("GET", "/api/knowledge/raw", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const path = url.searchParams.get("path");
  if (!path) { sendJson(res, 400, { error: "path query parameter is required" }); return; }
  const raw = knowledgeStore.getRawEntry(path);
  if (!raw) { sendJson(res, 404, { error: "Document not found" }); return; }
  res.writeHead(200, {
    "Content-Type": raw.contentType,
    "Content-Length": raw.data.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(raw.data);
});

addRoute("POST", "/api/knowledge/upload", async (req, res) => {
  const body = (await parseBody(req)) as { path?: string; dataBase64?: string; contentType?: string };
  if (!body.path || !body.dataBase64) {
    sendJson(res, 400, { error: "path and dataBase64 are required" });
    return;
  }
  if (body.contentType && body.contentType !== "image/png") {
    sendJson(res, 400, { error: "Only image/png uploads are supported" });
    return;
  }
  try {
    const data = Buffer.from(body.dataBase64, "base64");
    const entry = knowledgeStore.writePngEntry(body.path, data);
    sendJson(res, 200, entry);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

addRoute("GET", "/api/knowledge/entry", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const path = url.searchParams.get("path");
  if (!path) { sendJson(res, 400, { error: "path query parameter is required" }); return; }
  const entry = knowledgeStore.getEntry(path);
  if (!entry) { sendJson(res, 404, { error: "Document not found" }); return; }
  sendJson(res, 200, entry);
});

addRoute("PUT", "/api/knowledge/entry", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const path = url.searchParams.get("path");
  if (!path) { sendJson(res, 400, { error: "path query parameter is required" }); return; }
  const body = (await parseBody(req)) as { title?: string; content?: string };
  if (!body.title || body.content === undefined) {
    sendJson(res, 400, { error: "title and content are required" });
    return;
  }
  try {
    const updated = knowledgeStore.updateEntry(path, body.title, body.content);
    if (!updated) { sendJson(res, 404, { error: "Document not found" }); return; }
    sendJson(res, 200, updated);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

addRoute("DELETE", "/api/knowledge/entry", async (req, res) => {
  const url = new URL(req.url || "", "http://localhost");
  const path = url.searchParams.get("path");
  if (!path) { sendJson(res, 400, { error: "path query parameter is required" }); return; }
  try {
    const result = deleteOne(path);
    if (!result.ok) {
      sendJson(res, 404, { error: result.error || "Document not found" });
      return;
    }
    sendJson(res, 200, { ok: true, type: result.type });
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

// -- Move / rename --

addRoute("POST", "/api/knowledge/move", async (req, res) => {
  const body = (await parseBody(req)) as { from?: string; to?: string };
  if (!body.from || !body.to) {
    sendJson(res, 400, { error: "from and to are required" });
    return;
  }
  try {
    const result = moveOne(body.from, body.to);
    if (!result.ok || !result.type || !result.to) {
      sendJson(res, 404, { error: result.error || "Source not found or destination conflicts" });
      return;
    }
    sendJson(res, 200, { ok: true, from: body.from, to: result.to, type: result.type });
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});

addRoute("POST", "/api/knowledge/batch-move", async (req, res) => {
  const body = (await parseBody(req)) as { paths?: string[]; destination?: string };
  if (!Array.isArray(body.paths) || body.paths.length === 0 || !body.destination) {
    sendJson(res, 400, { error: "paths and destination are required" });
    return;
  }

  const failed: string[] = [];
  let moved = 0;
  for (const path of body.paths) {
    const result = moveOne(path, body.destination);
    if (!result.ok) {
      failed.push(path);
      continue;
    }
    moved += 1;
  }

  sendJson(res, 200, { ok: true, moved, failed });
});

addRoute("POST", "/api/knowledge/batch-delete", async (req, res) => {
  const body = (await parseBody(req)) as { paths?: string[] };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    sendJson(res, 400, { error: "paths are required" });
    return;
  }

  const failed: string[] = [];
  let deleted = 0;
  for (const path of body.paths) {
    const result = deleteOne(path);
    if (!result.ok) {
      failed.push(path);
      continue;
    }
    deleted += 1;
  }

  sendJson(res, 200, { ok: true, deleted, failed });
});
