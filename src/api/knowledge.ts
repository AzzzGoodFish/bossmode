// Knowledge API routes — Knowledge Base and Entry CRUD
import { addRoute, sendJson, parseBody } from "./index.js";
import * as knowledgeStore from "../knowledge/store.js";

addRoute("GET", "/api/knowledge", async (_req, res) => {
  sendJson(res, 200, knowledgeStore.listKnowledgeBases());
});

addRoute("POST", "/api/knowledge", async (req, res) => {
  const body = (await parseBody(req)) as { name?: string; description?: string };
  if (!body.name) { sendJson(res, 400, { error: "name is required" }); return; }
  const kb = knowledgeStore.createKnowledgeBase(body.name, body.description || "");
  sendJson(res, 200, kb);
});

addRoute("GET", "/api/knowledge/:id", async (_req, res, params) => {
  const kb = knowledgeStore.getKnowledgeBase(params.id);
  if (!kb) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  sendJson(res, 200, kb);
});

addRoute("DELETE", "/api/knowledge/:id", async (_req, res, params) => {
  if (!knowledgeStore.deleteKnowledgeBase(params.id)) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  sendJson(res, 200, { ok: true });
});

addRoute("GET", "/api/knowledge/:id/entries", async (req, res, params) => {
  if (!knowledgeStore.getKnowledgeBase(params.id)) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  const url = new URL(req.url || "", "http://localhost");
  const type = url.searchParams.get("type") as "rule" | "knowledge" | null;
  sendJson(res, 200, knowledgeStore.listEntries(params.id, type ? { type } : undefined));
});

addRoute("POST", "/api/knowledge/:id/entries", async (req, res, params) => {
  if (!knowledgeStore.getKnowledgeBase(params.id)) { sendJson(res, 404, { error: "Knowledge base not found" }); return; }
  const body = (await parseBody(req)) as { title?: string; content?: string; source?: string; type?: "rule" | "knowledge" };
  if (!body.title || !body.content) { sendJson(res, 400, { error: "title and content are required" }); return; }
  const entry = knowledgeStore.addEntry(params.id, body.title, body.content, body.source || "user", body.type || "knowledge");
  sendJson(res, 200, entry);
});

addRoute("PUT", "/api/knowledge/:id/entries/:eid", async (req, res, params) => {
  const body = (await parseBody(req)) as { title?: string; content?: string };
  if (!body.title || !body.content) { sendJson(res, 400, { error: "title and content are required" }); return; }
  const updated = knowledgeStore.updateEntry(params.id, params.eid, body.title, body.content);
  if (!updated) { sendJson(res, 404, { error: "Entry not found" }); return; }
  sendJson(res, 200, updated);
});

addRoute("DELETE", "/api/knowledge/:id/entries/:eid", async (_req, res, params) => {
  if (!knowledgeStore.deleteEntry(params.id, params.eid)) { sendJson(res, 404, { error: "Entry not found" }); return; }
  sendJson(res, 200, { ok: true });
});
