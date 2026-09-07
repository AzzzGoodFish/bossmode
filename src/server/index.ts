import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";
import { handleApiRequest } from "../api/index.js";
import { createWebSocketServer, shutdownWebSocket } from "../communication/ws.js";
import { removePidFile, writePidFile, ensureBossmodeDir, readConfig } from "../shared/config.js";
import { runKnowledgeMigration } from "../knowledge/migration.js";
import { runRoomMemberMigration } from "../workspace/room-member-migration.js";
import { runMemberCredentialBindingMigration } from "../workspace/member-credential-binding-migration.js";
import { runMessageSeqMigration } from "../workspace/message-seq-migration.js";
import { runMemoryStorageReorgMigration } from "../workspace/memory-storage-reorg-migration.js";
import { runPromptMemoryRenameMigration } from "../workspace/prompt-memory-rename-migration.js";
import { runPromptAssetsRenameMigration } from "../workspace/prompt-assets-rename-migration.js";
import { runMainlineEnglishHeadingsMigration } from "../workspace/mainline-english-headings-migration.js";
import { runMemberStatsBackfillMigration } from "../workspace/member-stats-backfill-migration.js";
import { runDmPhantomMessagesMigration } from "../workspace/dm-phantom-messages-migration.js";
import { runMemberOverridesCleanupMigration } from "../workspace/member-overrides-cleanup-migration.js";
import { runMemberGlobalMigration } from "../workspace/member-global-migration.js";
import { runSummaryRemovalMigration } from "../workspace/summary-removal-migration.js";
import { runAgentEventsRekeyMigration } from "../workspace/agent-events-rekey-migration.js";
import { runIdentityMigrationOnStartup } from "../workspace/identity-migration.js";
import { runMemberAssetsMigrationOnStartup } from "../workspace/member-assets-migration.js";
import { runRoomAttachmentsMigrationOnStartup } from "../workspace/room-attachments-migration.js";
import { initProjection } from "../workspace/db/projection.js";
import { ensurePiCatalogWarm, startCatalogAutoRefreshScheduler } from "../engine/model-credentials.js";
import { initAgentManager, shutdownAll as shutdownAgents, getActiveInstanceCount, wireMentionRouter } from "../engine/agent-manager.js";
import { sweepInterruptedBackgroundTasks } from "../engine/background-task-store.js";

import { RuntimeRegistry } from "../engine/runtime/registry.js";
import { PiSdkRuntime } from "../engine/runtime/pi-sdk.js";
import { logger } from "../foundation/logger.js";
import * as roomStore from "../workspace/room-store.js";
import { seedBuiltinAssets } from "../workforce/team-updates.js";
import { postMessage } from "../communication/message-bus.js";

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
}

export function startServer(opts: ServerOptions): Promise<void> {
  // Ensure dirs + seed builtin team files on first run
  ensureBossmodeDir();
  seedBuiltinAssets();

  // Knowledge: migrate legacy JSON-entry KBs to filesystem-markdown layout (idempotent)
  try {
    runKnowledgeMigration();
  } catch (err) {
    logger.error("server", "knowledge migration failed", { error: String(err) });
  }

  try {
    runRoomMemberMigration();
  } catch (err) {
    logger.error("server", "room member migration failed", { error: String(err) });
  }

  try {
    runMemberCredentialBindingMigration();
  } catch (err) {
    logger.error("server", "member credential binding migration failed", { error: String(err) });
  }

  try {
    runMessageSeqMigration();
  } catch (err) {
    logger.error("server", "message seq migration failed", { error: String(err) });
  }

  try {
    runMemoryStorageReorgMigration();
  } catch (err) {
    logger.error("server", "memory storage reorg migration failed", { error: String(err) });
  }

  try {
    runPromptMemoryRenameMigration();
  } catch (err) {
    logger.error("server", "prompt memory rename migration failed", { error: String(err) });
  }

  try {
    runPromptAssetsRenameMigration();
  } catch (err) {
    logger.error("server", "prompt assets rename migration failed", { error: String(err) });
  }

  try {
    runMainlineEnglishHeadingsMigration();
  } catch (err) {
    logger.error("server", "mainline english headings migration failed", { error: String(err) });
  }

  try {
    runMemberStatsBackfillMigration();
  } catch (err) {
    logger.error("server", "member stats backfill migration failed", { error: String(err) });
  }

  try {
    runDmPhantomMessagesMigration();
  } catch (err) {
    logger.error("server", "dm phantom messages migration failed", { error: String(err) });
  }

  try {
    const result = runMemberGlobalMigration();
    if (!result.skipped) {
      logger.info("server", "member-global-v1 migration applied", result);
    }
  } catch (err) {
    logger.error("server", "member-global-v1 migration failed", { error: String(err) });
  }

  // Runs after member-global-v1: cleanup needs rooms stamped (globalMemberIds)
  // to know memberOverrides is no longer consulted.
  try {
    const result = runMemberOverridesCleanupMigration();
    if (result.entriesRemoved > 0 || result.entriesKeptSuspicious > 0 || result.legacyRoomsSkipped > 0) {
      logger.info("server", "cleanup-member-overrides-v1 migration applied", { ...result });
    }
  } catch (err) {
    logger.error("server", "cleanup-member-overrides migration failed", { error: String(err) });
  }

  try {
    const result = runSummaryRemovalMigration();
    if (!result.skipped) {
      logger.info("server", "summary-removal-v1 migration applied", result);
    }
  } catch (err) {
    logger.error("server", "summary-removal-v1 migration failed", { error: String(err) });
  }

  // Initialize the SQLite projection (0.19.1). Non-blocking: a fresh DB
  // backfills in the background; failure never blocks the server (file-only).
  try {
    initProjection();
  } catch (err) {
    logger.error("server", "projection init failed", { error: String(err) });
  }

  // F5: rekey legacy agent-events artifacts (name/rm_ keys) to mem_ identity.
  // Runs after projection init so stale index rows can be deleted and the
  // merged files re-indexed immediately. Data-driven idempotent — re-runs are
  // no-ops once no resolvable legacy files remain.
  try {
    const result = runAgentEventsRekeyMigration();
    if (result.roomsWithChanges > 0 || result.orphans.length > 0) {
      logger.info("server", "agent-events-rekey-v1 migration applied", { ...result });
    }
  } catch (err) {
    logger.error("server", "agent-events-rekey migration failed", { error: String(err) });
  }

  // Identity/three-memory redesign: auto-migrate leftover legacy assets before listen.
  // Data-driven (F1); failure never blocks startup — archive prompt lines remain visible.
  try {
    runIdentityMigrationOnStartup();
    runMemberAssetsMigrationOnStartup();
    runRoomAttachmentsMigrationOnStartup();
  } catch (err) {
    logger.error("server", "identity-memory-v1 startup migration failed", { error: String(err) });
  }

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

  // One-shot migration: drop legacy watches.json (async watch → blocking wait).
  // No dual-mode / no fallback — leftover subscriptions are cleared with a room note.
  let clearedWatches = 0;
  for (const room of roomStore.listRooms()) {
    const watchesPath = join(roomStore.roomDir(room.id), "watches.json");
    if (!existsSync(watchesPath)) continue;
    try {
      unlinkSync(watchesPath);
      clearedWatches += 1;
      try {
        postMessage(room.id, "system", "Legacy watch subscriptions were cleared — use the blocking `wait` tool instead of watch.");
      } catch { /* room may not be fully ready */ }
    } catch (err) {
      logger.warn("server", "failed to clear watches.json", { roomId: room.id, error: String(err) });
    }
  }
  if (clearedWatches > 0) {
    logger.info("server", "cleared legacy watches.json files", { count: clearedWatches });
  }

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
