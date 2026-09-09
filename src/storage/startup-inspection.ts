// Read-only, pre-bootstrap CLI inspection. Never used by business consumers.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, isAbsolute } from "node:path";
import { requireRegularFile } from "./upgrade-files.js";

export interface StartupSettingsSnapshot { configured: boolean; host?: string; port?: number; source: "empty" | "legacy" | "database"; }
export const CORE_STORAGE_FORMAT = 1;
function address(value: {host?: unknown; port?: unknown}, source: StartupSettingsSnapshot["source"]): StartupSettingsSnapshot {
  if (typeof value.host !== "string" || !value.host || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new Error("Stored startup address is invalid; configuration was not replaced");
  return {configured:true,host:value.host,port:Number(value.port),source};
}

/** Legacy settings are visible only before a completed core authority marker.
 * An unreadable/incompatible authoritative DB never falls back to config.json.
 * This selects setup/display behavior only; the daemon imports and owns settings.
 */
export function inspectStartupSettings(root: string): StartupSettingsSnapshot {
  if (!isAbsolute(root)) throw new Error("Startup data root must be absolute");
  const path=join(root,"bossmode.db");
  if (existsSync(path)) {
    requireRegularFile(path);
    const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db=new DatabaseSync(path,{readOnly:true});
    try {
      db.exec("PRAGMA query_only=ON");
      const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_meta'").get();
      const marker=table ? db.prepare("SELECT value FROM storage_meta WHERE key='core-authority'").get() : undefined;
      if (marker) {
        let format: unknown;
        try { format=JSON.parse(String(marker.value)).format; } catch { throw new Error("Invalid storage authority marker"); }
        if (format !== CORE_STORAGE_FORMAT) throw new Error("Unsupported storage format; startup configuration was not changed");
        const row=db.prepare("SELECT host,port FROM app_settings WHERE id=1").get();
        const login=db.prepare("SELECT username,password_hash FROM login_credentials WHERE id=1").get();
        if (!row || !login || typeof login.username !== "string" || typeof login.password_hash !== "string") throw new Error("Authoritative startup configuration is incomplete; refusing account replacement");
        return address(row,"database");
      }
    } finally { db.close(); }
  }
  const legacy=join(root,"config.json");
  if (!existsSync(legacy)) return {configured:false,source:"empty"};
  requireRegularFile(legacy);
  let value: any;
  try { value=JSON.parse(readFileSync(legacy,"utf8")); } catch { throw new Error("Legacy startup configuration cannot be parsed; it was not replaced"); }
  if (!value || typeof value.auth?.username !== "string" || typeof value.auth?.passwordHash !== "string" || !value.defaults) throw new Error("Legacy startup configuration is incomplete; it was not replaced");
  return address(value.defaults,"legacy");
}
