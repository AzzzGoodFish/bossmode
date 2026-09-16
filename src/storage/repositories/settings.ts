import { createHash } from "node:crypto";
import type { Database } from "../database.js";
import type { BossmodeConfig } from "../../kernel/types.js";
import { bool } from "./settings-codec.js";

/** Secret-bearing internal settings API; public transports must select/redact fields. */
export class SettingsRepository {
  constructor(private readonly db: Database) {}
  exists(): boolean { return !!this.db.get("SELECT id FROM app_settings WHERE id=1"); }
  read(): BossmodeConfig | null {
    const r = this.db.get<any>("SELECT * FROM app_settings WHERE id=1");
    if (!r) return null;
    const auth = this.db.get<any>("SELECT * FROM login_credentials WHERE id=1");
    if (!auth) throw new Error("Login credentials are missing");
    return {
      auth: { username: auth.username, passwordHash: auth.password_hash },
      apiKeys: Object.fromEntries(this.db.all<any>("SELECT * FROM provider_api_keys").map(k => [k.provider, k.api_key])),
      defaults: { host: r.host, port: r.port },
      ...(r.mcp_enabled === null ? {} : { mcp: { enabled: !!r.mcp_enabled } }),
      ...(r.catalog_interval_days === null ? {} : { catalog: { autoRefreshIntervalDays: r.catalog_interval_days } }),
    };
  }
  /** Typed importer/upsert. Legacy sessionResume conversion belongs to the startup importer. */
  importConfig(c: BossmodeConfig): void {
    this.db.transaction(tx => {
      tx.run(`INSERT OR REPLACE INTO app_settings VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?)`, c.defaults.host, c.defaults.port,
        1, "fork", // session_resume fixed on; topic_seed_mode retired (fish #19358): legacy column, no writer input
        null, null, null, // codex_transport / websocket_connect_timeout_ms / http_idle_timeout_ms retired (P1)
        bool(c.mcp?.enabled), null, null, null, null, // memory budgets retired (P1)
        c.catalog?.autoRefreshIntervalDays ?? null);
      tx.run("INSERT OR REPLACE INTO login_credentials VALUES (1,?,?)", c.auth.username, c.auth.passwordHash);
      tx.run("DELETE FROM provider_api_keys");
      for (const [provider, key] of Object.entries(c.apiKeys)) tx.run("INSERT INTO provider_api_keys VALUES (?,?)", provider, key);
    });
  }
}

export class AuthSessionsRepository {
  constructor(private readonly db: Database) {}
  private hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  expiresAt(token: string): number | null { return this.db.get<{ expires_at: number }>("SELECT expires_at FROM auth_sessions WHERE token_hash=?", this.hash(token))?.expires_at ?? null; }
  set(token: string, expiresAt: number): void { this.importSessionHash(this.hash(token), expiresAt); }
  importSessionHash(tokenHash: string, expiresAt: number): void {
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isFinite(expiresAt)) throw new Error("Invalid auth session");
    this.db.run("INSERT OR REPLACE INTO auth_sessions VALUES (?,?)", tokenHash, expiresAt);
  }
  delete(token: string): void { this.db.run("DELETE FROM auth_sessions WHERE token_hash=?", this.hash(token)); }
  clear(): void { this.db.run("DELETE FROM auth_sessions"); }
  validate(token: string, now: number, ttl: number): boolean {
    return this.db.transaction(() => {
      const expires = this.expiresAt(token);
      if (expires === null) return false;
      if (now > expires) { this.delete(token); return false; }
      if (expires - now < ttl / 2) this.set(token, now + ttl);
      return true;
    });
  }
}
