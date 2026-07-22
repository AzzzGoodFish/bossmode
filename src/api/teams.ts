// Team template API — list/get/import/export
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { addRoute, sendJson } from "./index.js";
import { getBossmodeDir } from "../shared/config.js";
import {
  exportTeamToZip,
  getTeamTemplate,
  importTeamFromZip,
  listTeamTemplates,
} from "../workspace/team-store.js";
import { logger } from "../foundation/logger.js";

function parseMultipartFile(req: IncomingMessage): Promise<{ tmpPath: string; filename: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        const ctype = String(req.headers["content-type"] || "");
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
        if (!boundaryMatch) {
          // raw body treated as zip bytes
          const tmpPath = join(getBossmodeDir(), ".tmp-team-import", `${randomUUID()}.zip`);
          mkdirSync(join(getBossmodeDir(), ".tmp-team-import"), { recursive: true });
          writeFileSync(tmpPath, buf);
          resolve({ tmpPath, filename: "upload.zip" });
          return;
        }
        const boundary = boundaryMatch[1] || boundaryMatch[2];
        const parts = buf.toString("binary").split(`--${boundary}`);
        for (const part of parts) {
          if (!part.includes("Content-Disposition") || part.includes('filename=""')) continue;
          const nameMatch = /filename="([^"]+)"/i.exec(part);
          const filename = nameMatch?.[1] || "upload.zip";
          const idx = part.indexOf("\r\n\r\n");
          if (idx < 0) continue;
          let body = part.slice(idx + 4);
          if (body.endsWith("\r\n")) body = body.slice(0, -2);
          const tmpPath = join(getBossmodeDir(), ".tmp-team-import", `${randomUUID()}.zip`);
          mkdirSync(join(getBossmodeDir(), ".tmp-team-import"), { recursive: true });
          writeFileSync(tmpPath, Buffer.from(body, "binary"));
          resolve({ tmpPath, filename });
          return;
        }
        reject(new Error("No file field in multipart body"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

addRoute("GET", "/api/teams", async (_req, res) => {
  try {
    sendJson(res, 200, { teams: listTeamTemplates() });
  } catch (err: any) {
    logger.error("teams-api", "list failed", { error: String(err) });
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

addRoute("GET", "/api/teams/:name", async (_req, res, params) => {
  try {
    const team = getTeamTemplate(params.name);
    if (!team) {
      sendJson(res, 404, { error: "Team template not found" });
      return;
    }
    sendJson(res, 200, { ...team, builtIn: team.meta.type === "builtin" });
  } catch (err: any) {
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

addRoute("POST", "/api/teams/import", async (req, res) => {
  let tmpPath: string | undefined;
  try {
    const file = await parseMultipartFile(req);
    tmpPath = file.tmpPath;
    if (!file.filename.toLowerCase().endsWith(".zip")) {
      sendJson(res, 400, { error: "Team import requires a .zip package" });
      return;
    }
    const team = importTeamFromZip(tmpPath);
    sendJson(res, 200, team);
  } catch (err: any) {
    logger.error("teams-api", "import failed", { error: String(err) });
    sendJson(res, 400, { error: err.message || String(err) });
  } finally {
    if (tmpPath && existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
});

addRoute("GET", "/api/teams/:name/export", async (_req, res, params) => {
  try {
    const team = getTeamTemplate(params.name);
    if (!team) {
      sendJson(res, 404, { error: "Team template not found" });
      return;
    }
    const outZip = join(getBossmodeDir(), ".tmp-team-export", `${team.slug}-${Date.now()}.zip`);
    mkdirSync(join(getBossmodeDir(), ".tmp-team-export"), { recursive: true });
    exportTeamToZip(team.slug, outZip);
    const data = readFileSync(outZip);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${team.slug}.zip"`,
      "Content-Length": data.length,
    });
    res.end(data);
    try { unlinkSync(outZip); } catch { /* ignore */ }
  } catch (err: any) {
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

