// API Router — route matching + CORS + auth guard + delegation to domain handlers
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAuth } from "./auth.js";
import { logger } from "../foundation/logger.js";

// -- Route types --

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

const routes: Route[] = [];

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    pattern: new RegExp(`^${pattern}$`),
    paramNames,
    handler,
  });
}

// -- Helpers --

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

export async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// -- Register all domain routes (lazy — called once on first request) --

import { login } from "./auth.js";

let routesRegistered = false;

async function ensureRoutesRegistered(): Promise<void> {
  if (routesRegistered) return;
  routesRegistered = true;

  // Auth route
  addRoute("POST", "/api/auth/login", async (req, res) => {
    const body = (await parseBody(req)) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      sendJson(res, 400, { error: "username and password required" });
      return;
    }
    const result = login(body.username, body.password);
    if (!result) {
      sendJson(res, 401, { error: "Invalid credentials" });
      return;
    }
    sendJson(res, 200, result);
  });


  // Domain routes — dynamic import to avoid ESM hoisting issues
  // 0.20 members/contacts/dm first so they shadow legacy workforce /api/members CRUD.
  await import("./members.js");
  await import("./conversations.js");
  await import("./workforce.js");
  await import("./workspace.js");
  await import("./teams.js");
  await import("./extensions.js");
  await import("./uploads.js");
  await import("./knowledge.js");
  await import("./engine-routes.js");
  await import("./mcp.js");
  await import("./fs.js");
  await import("./tasks.js");
  await import("./artifacts.js");
  await import("./integrations.js");
  await import("./usage.js");
}

// -- Main request handler --

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  await ensureRoutesRegistered();
  const rawUrl = req.url || "";
  const method = req.method || "GET";

  if (!rawUrl.startsWith("/api/") && !rawUrl.startsWith("/internal/")) return false;

  // Strip query string for route matching
  const url = rawUrl.split("?")[0];

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Auth check (skip login endpoint only)
  // Attachment GET routes skip auth — filenames are sha256 hashes (unguessable), roomIds are UUIDs.
  // Browser <img src> and <a download> don't send Authorization headers.
  // See TD-A18 for long-term cookie-session migration plan.
  const isAttachmentGet = req.method === "GET" && /^\/api\/rooms\/[^/]+\/attachments\//.test(url);
  if (url !== "/api/auth/login" && !isAttachmentGet && !requireAuth(req.headers)) {
    sendJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = url.match(route.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      // Decode path params so names with spaces (e.g. Default%20Team) resolve.
      try { params[name] = decodeURIComponent(match[i + 1]); }
      catch { params[name] = match[i + 1]; }
    });

    try {
      await route.handler(req, res, params);
    } catch (err: any) {
      logger.error("api", `${method} ${url}`, { error: err.message || String(err) });
      sendJson(res, 500, { error: err.message || "Internal server error" });
    }
    return true;
  }

  sendJson(res, 404, { error: "Not found" });
  return true;
}
