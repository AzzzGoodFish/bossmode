import type { IncomingMessage, ServerResponse } from "node:http";
import { logger } from "../kernel/logger.js";
import { login, requireAuth } from "./auth.js";

export type RouteHandler = (request: IncomingMessage, response: ServerResponse, params: Record<string, string>) => Promise<void>;
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function requestValue<T>(action: () => T | Promise<T>, status = 400, code = "invalid_request"): Promise<T> {
  try { return await action(); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(status, code, error instanceof Error ? error.message : String(error)); }
}
interface Route { method: string; pattern: RegExp; paramNames: string[]; handler: RouteHandler }
const routes: Route[] = [];

export function addRoute(method: string, path: string, handler: RouteHandler): void {
  const paramNames: string[] = [];
  const source = path.replace(/:(\w+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({ method, pattern: new RegExp(`^${source}$`), paramNames, handler });
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function parseBody(request: IncomingMessage, maximum = 1024 * 1024): Promise<unknown> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid request size limit");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maximum) {
        request.destroy();
        reject(new Error("Request body too large"));
      } else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(new Error("Invalid JSON body")); }
    });
    request.on("error", reject);
  });
}

export function requestUrl(request: Pick<IncomingMessage, "url">): URL {
  return new URL(request.url || "", "http://localhost");
}

addRoute("POST", "/api/auth/login", async (request, response) => {
  const body = await parseBody(request) as { username?: string; password?: string };
  if (!body.username || !body.password) return sendJson(response, 400, { error: "username and password required" });
  const result = login(body.username, body.password);
  if (!result) return sendJson(response, 401, { error: "Invalid credentials" });
  sendJson(response, 200, result);
});

/** Domain route modules are imported once by app/wire before serving. Keeping
 * registration out of request handling avoids API module cycles and races. */
export async function handleApiRequest(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const rawUrl = request.url || "";
  if (!rawUrl.startsWith("/api/") && !rawUrl.startsWith("/internal/")) return false;
  const method = request.method || "GET";
  const path = rawUrl.split("?")[0];
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (method === "OPTIONS") { response.writeHead(204); response.end(); return true; }
  const publicAttachment = method === "GET" && /^\/api\/conversations\/[^/]+\/attachments\//.test(path);
  if (path !== "/api/auth/login" && !publicAttachment && !requireAuth(request.headers)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return true;
  }
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.pattern);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      try { params[name] = decodeURIComponent(match[index + 1]); }
      catch { params[name] = match[index + 1]; }
    });
    try { await route.handler(request, response, params); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof HttpError) || error.status >= 500) logger.error("api", `${method} ${path}`, { error: message });
      const status = error instanceof HttpError ? error.status : 500;
      sendJson(response, status, { error: error instanceof HttpError ? error.code : "internal", message: message || "Internal server error" });
    }
    return true;
  }
  sendJson(response, 404, { error: "Not found" });
  return true;
}
