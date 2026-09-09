import { prepareCoreStorage } from "../storage/core-startup.js";
import type { UpgradeProgress } from "../storage/upgrade-runner.js";
import type { BossmodeConfig } from "../shared/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { handleApiRequest } from "../api/index.js";
import { createWebSocketServer, shutdownWebSocket } from "../communication/ws.js";
import { removePidFile, writePidFile, ensureBossmodeDir, readConfig, writeConfig, getBossmodeDir } from "../shared/config.js";
import { ensurePiCatalogWarm, startCatalogAutoRefreshScheduler } from "../engine/model-credentials.js";
import { initAgentManager, shutdownAll as shutdownAgents, getActiveInstanceCount, wireMentionRouter } from "../engine/agent-manager.js";
import { sweepInterruptedBackgroundTasks } from "../engine/background-task-store.js";

import { RuntimeRegistry } from "../engine/runtime/registry.js";
import { PiSdkRuntime } from "../engine/runtime/pi-sdk.js";
import { logger } from "../foundation/logger.js";
import * as roomStore from "../workspace/room-store.js";
import { seedBuiltinAssets } from "../workforce/team-updates.js";

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
  ensureBossmodeDir();
  await prepareCoreStorage({root:getBossmodeDir(),initialConfig:opts.initialConfig,onProgress:opts.onProgress,
    activate:async()=>{await startApplication(opts);}});
}

async function startApplication(opts: ServerOptions): Promise<void> {
  seedBuiltinAssets();
  // Background tasks: service-startup-only sweep. Non-terminal tasks from a
  // previous daemon run are marked interrupted (terminal; never resumed).
  // Runs exactly here — never on member reload or session rebuild.
  try {
    const marked = sweepInterruptedBackgroundTasks();
    if (marked > 0) logger.info("server", "background tasks marked interrupted by restart", { marked });
  } catch (err) {
    logger.error("server", "background task restart sweep failed", { error: String(err) });
  }

  // Warm the credential-less pi model catalog cache (provider list, model metadata) so
  // synchronous readers (Settings → Model Credentials, provider validation) have data
  // immediately instead of the cold-cache empty fallback on first request.
  void ensurePiCatalogWarm();
  // Built-in catalog auto-refresh (default every 7 days; checks daily).
  startCatalogAutoRefreshScheduler();

  // Initialize runtime registry
  const registry = new RuntimeRegistry();
  registry.register(new PiSdkRuntime());
  initAgentManager(registry);

  // Session-resume OFF means fresh runtime sessions; reset cursors so agents receive
  // recent room context on next activation instead of an empty incremental window.
  const config = readConfig();
  if (config.runtime?.sessionResume === false) {
    let resetCount = 0;
    for (const room of roomStore.listRooms()) {
      const cursors = roomStore.getCursors(room.id);
      for (const agentName of Object.keys(cursors)) {
        roomStore.setCursor(room.id, agentName, null);
        resetCount += 1;
      }
    }
    logger.info("server", "cursors reset — session resume disabled", { resetCount });
  }

  // Initialize communication router — topic: scopes dispatch to activateTopicMember.
  const unsubscribeRouter = wireMentionRouter();

  return new Promise((resolve, reject) => {
    const webDistDir = join(import.meta.dirname, "../../web/dist");

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
    });

    // WebSocket
    createWebSocketServer(server);

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${opts.port} is already in use`));
      } else {
        reject(err);
      }
    });

    server.listen(opts.port, opts.host, () => {
      const address = `http://${opts.host === "0.0.0.0" ? "localhost" : opts.host}:${opts.port}`;
      logger.info("server", `running at ${address}`, { host: opts.host, port: opts.port });
      const config = readConfig();
      config.defaults = {host:opts.host,port:opts.port};
      writeConfig(config);
      writePidFile(process.pid);
      resolve();
    });

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

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info("server", `shutdown signal: ${signal}`, { activeInstances: getActiveInstanceCount() });
      unsubscribeRouter();
      await shutdownAgents();
      shutdownWebSocket();
      server.close(() => {
        removePidFile();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));
  });
}
