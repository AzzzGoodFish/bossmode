// Knowledge API — single-namespace document management (0.8.0)
// ===============================================================
// All docs live under the shared project-memory tree.

import { addRoute, HttpError, sendJson, parseBody, requestValue } from "./http.js";
import * as knowledgeStore from "../knowledge/documents.js";

function queryPath(req: { url?: string }): string {
  const path = new URL(req.url || "", "http://localhost").searchParams.get("path");
  if (!path) throw new HttpError(400, "path_required", "path query parameter is required");
  return path;
}

function batch(paths: string[], action: (path: string) => { ok: boolean }): { count: number; failed: string[] } {
  const failed: string[] = [];
  let count = 0;
  for (const path of paths) action(path).ok ? count++ : failed.push(path);
  return { count, failed };
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
  const entry = await requestValue(() => knowledgeStore.addEntry(
    body.title!, body.content!, body.source || "user", body.path));
  sendJson(res, 200, entry);
});

// -- Single-doc read / update / delete (path via query string) --

addRoute("GET", "/api/knowledge/raw", async (req, res) => {
  const path = queryPath(req);
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
  const entry = await requestValue(() => knowledgeStore.writePngEntry(body.path!, Buffer.from(body.dataBase64!, "base64")));
  sendJson(res, 200, entry);
});

addRoute("GET", "/api/knowledge/entry", async (req, res) => {
  const path = queryPath(req);
  const entry = knowledgeStore.getEntry(path);
  if (!entry) { sendJson(res, 404, { error: "Document not found" }); return; }
  sendJson(res, 200, entry);
});

addRoute("PUT", "/api/knowledge/entry", async (req, res) => {
  const path = queryPath(req);
  const body = (await parseBody(req)) as { content?: string };
  if (body.content === undefined) return sendJson(res, 400, { error: "content is required" });
  const updated = await requestValue(() => knowledgeStore.updateEntry(path, body.content!));
  if (!updated) return sendJson(res, 404, { error: "Document not found" });
  sendJson(res, 200, updated);
});

addRoute("DELETE", "/api/knowledge/entry", async (req, res) => {
  const path = queryPath(req);
  const result = await requestValue(() => knowledgeStore.deletePath(path));
  if (!result.ok) return sendJson(res, 404, { error: result.error || "Document not found" });
  sendJson(res, 200, { ok: true, type: result.type });
});

// -- Move / rename --

addRoute("POST", "/api/knowledge/move", async (req, res) => {
  const body = (await parseBody(req)) as { from?: string; to?: string };
  if (!body.from || !body.to) {
    sendJson(res, 400, { error: "from and to are required" });
    return;
  }
  const result = await requestValue(() => knowledgeStore.movePath(body.from!, body.to!));
  if (!result.ok) return sendJson(res, 404, { error: result.error });
  if (!result.to) return sendJson(res, 404, { error: "Source not found or destination conflicts" });
  sendJson(res, 200, { ok: true, from: result.from, to: result.to, type: result.type });
});

addRoute("POST", "/api/knowledge/batch-move", async (req, res) => {
  const body = (await parseBody(req)) as { paths?: string[]; destination?: string };
  if (!Array.isArray(body.paths) || body.paths.length === 0 || !body.destination) {
    sendJson(res, 400, { error: "paths and destination are required" });
    return;
  }

  const result = batch(body.paths, path => knowledgeStore.movePath(path, body.destination!));
  sendJson(res, 200, { ok: true, moved: result.count, failed: result.failed });
});

addRoute("POST", "/api/knowledge/batch-delete", async (req, res) => {
  const body = (await parseBody(req)) as { paths?: string[] };
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    sendJson(res, 400, { error: "paths are required" });
    return;
  }

  const result = batch(body.paths, knowledgeStore.deletePath);
  sendJson(res, 200, { ok: true, deleted: result.count, failed: result.failed });
});
