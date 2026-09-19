import { getDatabase, sqliteBoolean, type Database } from "../data/database.js";
import type { BossmodeConfig } from "../kernel/types.js";

/** Internal secret-bearing configuration; public transports select their own fields. */
export function readConfig(db: Database = getDatabase()): BossmodeConfig {
  const row = db.get<any>("SELECT * FROM app_settings WHERE id=1");
  if (!row) throw new Error("Application configuration is not initialized");
  const auth = db.get<any>("SELECT * FROM login_credentials WHERE id=1");
  if (!auth) throw new Error("Login credentials are missing");
  return {
    auth: { username: auth.username, passwordHash: auth.password_hash },
    apiKeys: Object.fromEntries(db.all<any>("SELECT * FROM provider_api_keys").map(key => [key.provider, key.api_key])),
    defaults: { host: row.host, port: row.port },
    ...(row.mcp_enabled === null ? {} : { mcp: { enabled: !!row.mcp_enabled } }),
    ...(row.catalog_interval_days === null ? {} : { catalog: { autoRefreshIntervalDays: row.catalog_interval_days } }),
  };
}

/** Atomic settings update, also used with the startup staging database. */
export function writeConfig(config: BossmodeConfig, db: Database = getDatabase()): void {
  db.transaction(tx => {
    tx.run("INSERT OR REPLACE INTO app_settings VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)", config.defaults.host, config.defaults.port,
      1, "fork", null, null, null, sqliteBoolean(config.mcp?.enabled), null, null, null, null,
      config.catalog?.autoRefreshIntervalDays ?? null);
    tx.run("INSERT OR REPLACE INTO login_credentials VALUES (1,?,?)", config.auth.username, config.auth.passwordHash);
    tx.run("DELETE FROM provider_api_keys");
    for (const [provider, key] of Object.entries(config.apiKeys)) tx.run("INSERT INTO provider_api_keys VALUES (?,?)", provider, key);
  });
}

export function getDefaultConfig(): BossmodeConfig {
  return { auth: { username: "", passwordHash: "" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, mcp: { enabled: false } };
}

/** User identity is stable internally; display uses the current installation login. */
export function getUserDisplayName(): string {
  try { return String(readConfig().auth.username ?? "").trim() || "User"; }
  catch { return "User"; }
}
