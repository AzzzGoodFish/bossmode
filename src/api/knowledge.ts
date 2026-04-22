// Knowledge API — single-namespace document management (0.8.0)
// ===============================================================
// All docs live under the single global tree at
// ~/.bossmode/knowledge/docs/. There is no KB container concept.
//
// Endpoints:
//   GET    /api/knowledge/tree                 — directory tree (for UI file explorer)
//   GET    /api/knowledge/entries              — flat list of all docs (id/title/source/updatedAt)
//   POST   /api/knowledge/entries              — create doc at explicit path
//     body: { title, content, path?, source? }
//   GET    /api/knowledge/entry?path=...       — read single doc by path
//   PUT    /api/knowledge/entry?path=...       — update doc (body: { title, content })
//   DELETE /api/knowledge/entry?path=...       — delete doc
//   POST   /api/knowledge/move                 — move/rename (body: { from, to })

import { addRoute, sendJson, parseBody } from "./index.js";
import * as knowledgeStore from "../knowledge/store.js";
import * as roomStore from "../workspace/room-store.js";
import { logger } from "../foundation/logger.js";

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
    if (!knowledgeStore.deleteEntry(path)) {
      sendJson(res, 404, { error: "Document not found" });
      return;
    }
    const affected = roomStore.updateRuleDocPaths(path);
    if (affected > 0) {
      logger.info("knowledge-api", "updated room ruleDocs refs after delete", { path, affectedRooms: affected });
    }
    sendJson(res, 200, { ok: true });
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
    const moved = knowledgeStore.moveEntry(body.from, body.to);
    if (!moved) { sendJson(res, 404, { error: "Source not found or destination conflicts" }); return; }
    const affected = roomStore.updateRuleDocPaths(body.from, moved.id);
    if (affected > 0) {
      logger.info("knowledge-api", "updated room ruleDocs refs after move", {
        from: body.from,
        to: moved.id,
        affectedRooms: affected,
      });
    }
    sendJson(res, 200, moved);
  } catch (err: any) {
    sendJson(res, 400, { error: String(err?.message || err) });
  }
});
