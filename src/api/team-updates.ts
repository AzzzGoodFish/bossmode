import { addRoute, parseBody, sendJson } from "./index.js";
import {
  checkForUpdates,
  applyUpdates,
  dismissVersion,
  dismissPermanently,
  getUpdateSettings,
} from "../workforce/team-updates.js";

addRoute("GET", "/api/team-updates/check", async (_req, res) => {
  sendJson(res, 200, checkForUpdates());
});

addRoute("POST", "/api/team-updates/apply", async (req, res) => {
  const body = await parseBody(req) as { paths?: string[] };
  if (!Array.isArray(body.paths)) {
    sendJson(res, 400, { error: "paths array required" });
    return;
  }
  sendJson(res, 200, applyUpdates(body.paths));
});

addRoute("POST", "/api/team-updates/dismiss", async (req, res) => {
  const body = await parseBody(req) as { type?: string; version?: string };
  if (body.type === "version" && body.version) {
    dismissVersion(body.version);
    sendJson(res, 200, { ok: true });
    return;
  }
  if (body.type === "permanent") {
    dismissPermanently(true);
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 400, { error: "invalid dismiss type" });
});

addRoute("GET", "/api/team-updates/settings", async (_req, res) => {
  sendJson(res, 200, getUpdateSettings());
});

addRoute("POST", "/api/team-updates/settings", async (req, res) => {
  const body = await parseBody(req) as { dismissPermanent?: boolean };
  if (typeof body.dismissPermanent === "boolean") {
    dismissPermanently(body.dismissPermanent);
  }
  sendJson(res, 200, getUpdateSettings());
});
