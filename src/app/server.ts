import { loadAgentMemberSnapshot } from "./member-actions.js";
import { readConfig, writeConfig } from "../config/settings.js";
import { ensureDirectory } from "../files/io.js";
import { getBossmodeDir } from "../files/layout.js";

import { recoverMemberArchives } from "./member-actions.js";
import { prepareCoreStorage } from "./upgrade/run.js";
import { type UpgradeProgress } from "./upgrade/inventory.js";
import type { BossmodeConfig } from "../config/settings.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { handleApiRequest } from "../api/http.js";
import { createWebSocketServer, shutdownWebSocket } from "./ws.js";

import { removePidFile, writePidFile } from "./process.js";
import { ensurePiCatalogWarm } from "../config/catalog.js";
import { startCatalogAutoRefreshScheduler } from "../config/models.js";
import { initializeMemberRuntime, getActiveInstanceCount } from "./member-actions.js";
import { shutdownAll as shutdownAgents } from "../agent/controls.js";
import { resumePendingRuntimeInputs } from "../agent/scheduler.js";

import { RuntimeRegistry } from "../agent/types.js";
import { PiSdkRuntime } from "../agent/runtime/pi.js";
import { logger } from "../kernel/logger.js";
import { seedBuiltinAssets } from "../member/templates.js";
import { wireApiRoutes, wireConfiguration, wireMemberProfiles, wireConversationMembers, wireMemberHttp, wireUsageHttp, wireChatHttp, wireAgentEvents } from "./wire.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res: ServerResponse, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const mime = MIME_TYPES[ext] || "application/octet-stream";
  const content = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": mime });
  res.end(content);
  return true;
}

export interface ServerOptions {
  host: string;
  port: number;
  initialConfig?: BossmodeConfig;
  onProgress?(progress: UpgradeProgress): void;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  ensureDirectory(getBossmodeDir());
  await prepareCoreStorage({root:getBossmodeDir(),initialConfig:opts.initialConfig,onProgress:opts.onProgress,
    activate:async()=>{await startApplication(opts);}});
}

async function startApplication(opts: ServerOptions): Promise<void> {
  await wireApiRoutes();
  seedBuiltinAssets();

  await recoverMemberArchives();

  // Initialize runtime registry
  const registry = new RuntimeRegistry();
  registry.register(new PiSdkRuntime());
  initializeMemberRuntime(registry, loadAgentMemberSnapshot);
  const unsubscribeConfiguration = wireConfiguration();
  const unsubscribeProfiles = wireMemberProfiles();
  const unsubscribeMembers = wireConversationMembers();
  const unsubscribeMemberHttp = wireMemberHttp();
  const unsubscribeUsageHttp = wireUsageHttp();
  const unsubscribeChats = wireChatHttp();
  const unsubscribeAgentEvents = wireAgentEvents();


  const webDistDir = join(import.meta.dirname, "../../web/dist");

  let accepting = true;
  const requests = new Set<Promise<void>>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!accepting) { res.writeHead(503); res.end("Server shutting down"); return; }
    const request = handleRequest(req,res);
    requests.add(request);
    void request.catch(error => {
      logger.error("server","request failed",{error:String(error)});
      if (!res.headersSent) res.writeHead(500);
      res.end("Request failed");
    }).finally(()=>requests.delete(request));
  });
  async function handleRequest(req: IncomingMessage,res: ServerResponse): Promise<void> {
    const url = req.url || "/";

    // API routes
    const handled = await handleApiRequest(req, res);
    if (handled) return;

    // Static file serving (production build)
    if (existsSync(webDistDir)) {
      const filePath = url === "/" ? join(webDistDir, "index.html") : join(webDistDir, url);
      if (serveStatic(res, filePath)) return;
      // SPA fallback
      if (serveStatic(res, join(webDistDir, "index.html"))) return;
    }

    // No frontend build available
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html><body>
        <h1>Bossmode</h1>
        <p>Server is running. Frontend not built yet.</p>
        <p>API available at <code>/api/</code></p>
      </body></html>
    `);
  }

  // WebSocket
  createWebSocketServer(server);
  let cleanupSettlement: Promise<void> | undefined;
  function cleanupOwnedResources(): Promise<void> {
    if (cleanupSettlement) return cleanupSettlement;
    accepting = false;
    unsubscribeConfiguration();
    unsubscribeProfiles();
    unsubscribeAgentEvents();
    unsubscribeChats();
    unsubscribeUsageHttp();
    unsubscribeMemberHttp();
    const closingWebSocket = shutdownWebSocket();
    const closingHttp = closeHttpServer(server);
    cleanupSettlement = (async () => {
      const results = await Promise.allSettled([closingHttp,closingWebSocket,shutdownAgents(),...requests]);
      const failures = results.filter((result): result is PromiseRejectedResult=>result.status==="rejected").map(result=>result.reason);
      if (failures.length) throw new AggregateError(failures,"Server cleanup incomplete");
    })().finally(unsubscribeMembers);
    return cleanupSettlement;
  }

  let publicationAttempted = false;
  await listenAndPublish(server, opts, () => {
    publicationAttempted = true;
    const config = readConfig();
    config.defaults = {host:opts.host,port:opts.port};
    writeConfig(config);
    writePidFile(process.pid);
  }, async () => {
    const failures: unknown[] = [];
    try { await cleanupOwnedResources(); } catch (error) { failures.push(error); }
    if (publicationAttempted) try { removePidFile(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures,"Startup resources did not close");
  });
  resumePendingRuntimeInputs();
  server.on("error", error => logger.error("server", "HTTP server error", {error:String(error)}));
  const address = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
  logger.info("server", `running at ${address}`, {host:opts.host,port:opts.port});
  // Warm the credential-less pi model catalog cache (provider list, model metadata) so
  // synchronous readers (Settings → Model Credentials, provider validation) have data
  // immediately instead of the cold-cache empty fallback on first request.
  void ensurePiCatalogWarm();
  // Built-in catalog auto-refresh (default every 7 days; checks daily).
  startCatalogAutoRefreshScheduler();

  // Uncaught exception handlers
  process.on("uncaughtException", (err) => {
    logger.error("server", "uncaughtException", { message: err.message, stack: err.stack?.slice(0, 500) });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("server", "unhandledRejection", { reason: String(reason).slice(0, 500) });
  });

  // Heartbeat — resource status every 60s
  setInterval(() => {
    const mem = process.memoryUsage();
    logger.info("server", "heartbeat", {
      heapMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      activeAgents: getActiveInstanceCount(),
    });
  }, 60000);

  // A failed/overdue shutdown is not successful cleanup. Stop ingress immediately,
  // attempt independent drains together, and exit nonzero with the PID evidence retained.
  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    logger.info("server", `shutdown signal: ${signal}`, {activeInstances:getActiveInstanceCount()});
    const deadline = setTimeout(() => {
      logger.error("server","shutdown deadline exceeded; cleanup remains unconfirmed");
      process.exit(1);
    },30_000);
    try {
      await cleanupOwnedResources();
      removePidFile();
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      logger.error("server","shutdown incomplete",{error:String(error)});
      clearTimeout(deadline);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => {void shutdown("SIGTERM");});
  process.on("SIGINT", () => {void shutdown("SIGINT");});
  process.on("SIGHUP", () => {void shutdown("SIGHUP");});
}


/** Publish readiness only after listening. Failed publication/listen awaits owned-resource cleanup. */
export async function listenAndPublish(
  server: import("node:http").Server, options: { host: string; port: number },
  publish: () => void, cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(error.code === "EADDRINUSE" ? new Error(`Port ${options.port} is already in use`) : error);
      };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError); server.once("listening", onListening);
      try { server.listen(options.port, options.host); }
      catch (error) { server.off("error", onError); server.off("listening", onListening); reject(error); }
    });
    publish();
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Startup and cleanup failed"); }
    throw error;
  }
}

export async function closeHttpServer(server: import("node:http").Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
