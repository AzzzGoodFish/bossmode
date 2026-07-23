// Extensions API — install/list/uninstall bossmode-managed pi packages
import { addRoute, sendJson, parseBody } from "./index.js";
import {
  installExtension,
  listInstalledExtensions,
  uninstallExtension,
  webSearchConfigExists,
  webSearchConfigPath,
} from "../workspace/extension-store.js";
import { logger } from "../foundation/logger.js";

addRoute("GET", "/api/extensions", async (_req, res) => {
  try {
    sendJson(res, 200, {
      extensions: listInstalledExtensions(),
      webSearchConfig: {
        path: webSearchConfigPath(),
        exists: webSearchConfigExists(),
      },
    });
  } catch (err: any) {
    logger.error("extensions-api", "list failed", { error: String(err) });
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

addRoute("POST", "/api/extensions/install", async (req, res) => {
  try {
    const body = (await parseBody(req)) as { package?: string };
    const pkg = typeof body.package === "string" ? body.package.trim() : "";
    if (!pkg) {
      sendJson(res, 400, { error: "package is required (e.g. \"pi-web-access\" or \"npm:pi-web-access\")" });
      return;
    }
    const record = installExtension(pkg);
    sendJson(res, 200, record);
  } catch (err: any) {
    logger.error("extensions-api", "install failed", { error: String(err) });
    sendJson(res, 400, { error: err.message || String(err) });
  }
});

addRoute("DELETE", "/api/extensions/:name", async (_req, res, params) => {
  try {
    const result = uninstallExtension(params.name);
    sendJson(res, 200, result);
  } catch (err: any) {
    logger.error("extensions-api", "uninstall failed", { error: String(err) });
    sendJson(res, 400, { error: err.message || String(err) });
  }
});
