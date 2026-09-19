import { getBossmodeDir } from "../files/layout.js";
import { getDatabase, type Database } from "../data/database.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
export interface McpServerAvailability {name:string;status:"unchecked"|"checking"|"available"|"unavailable"|"auth-required"|"invalid-config";checkedAt?:number;toolCount?:number;resourceCount?:number;error?:string;}
export interface McpServerSummary {name:string;transport:"http"|"stdio"|"invalid";assignedCount?:number;availability?:McpServerAvailability;}
import { defined, objectJson, parseObject, requireObject } from "../kernel/json.js";

export const MCP_REDACTED_VALUE = "[REDACTED]";

export function getBossmodeMcpDir(): string {
  return join(getBossmodeDir(), "mcp");
}

export function getBossmodeMcpRuntimeDir(): string {
  return join(getBossmodeMcpDir(), "runtime");
}

export function getMcpServersObject(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  const servers = (config as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

export function getMcpServerNames(config: unknown): string[] {
  return Object.keys(getMcpServersObject(config));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Classify credential flags without treating ordinary positional/option values as secrets. */
function credentialArgument(value: unknown): { flag: string; secret?: string } | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(-{1,2}[^=\s]+)(?:=([\s\S]*))?$/);
  if (!match) return null;
  const flag = match[1].replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const secretFlag = /(?:^|[-_])(?:api[-_]?key|private[-_]?key|access[-_]?key|token|secret|password|passwd|authorization|bearer|credentials?)$/.test(flag);
  return secretFlag ? { flag: match[1], secret: match[2] } : null;
}

export function restoreRedactedMcpConfig(submitted: unknown, existing: unknown): unknown {
  if (submitted === MCP_REDACTED_VALUE && existing !== undefined) return existing;
  const submittedArg = credentialArgument(submitted);
  const existingArg = credentialArgument(existing);
  if (submittedArg?.secret === MCP_REDACTED_VALUE && existingArg?.flag === submittedArg.flag) return existing;
  if (Array.isArray(submitted)) {
    const existingArray = Array.isArray(existing) ? existing : [];
    return submitted.map((item, index) => restoreRedactedMcpConfig(item, existingArray[index]));
  }
  if (isRecord(submitted)) {
    const existingRecord = isRecord(existing) ? existing : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(submitted)) {
      out[key] = restoreRedactedMcpConfig(value, existingRecord[key]);
    }
    return out;
  }
  return submitted;
}

export function inferMcpServerTransport(entry: unknown): McpServerSummary["transport"] {
  if (!isRecord(entry)) return "invalid";
  if (typeof entry.url === "string" && entry.url.trim()) {
    try {
      const url = new URL(entry.url);
      return url.protocol === "http:" || url.protocol === "https:" ? "http" : "invalid";
    } catch {
      return "invalid";
    }
  }
  if (typeof entry.command === "string" && entry.command.trim()) return "stdio";
  return "invalid";
}

export function isAssignableMcpServerConfig(entry: unknown): boolean {
  return inferMcpServerTransport(entry) !== "invalid";
}

export function getAssignableMcpServerNames(config: unknown): string[] {
  const servers = getMcpServersObject(config);
  return getMcpServerNames(config).filter((name) => isAssignableMcpServerConfig(servers[name]));
}

export function readMcpStatusCache(): Record<string, McpServerAvailability & { configHash?: string }> {
  return readMcpAvailability(getDatabase());
}

const DEFERRED_MCP_CAPABILITY_KEYS = new Set(["sampling", "samplingautoapprove", "elicitation", "directtools"]);

export function disableDeferredMcpCapabilities(value: unknown, key?: string): unknown {
  if (key && DEFERRED_MCP_CAPABILITY_KEYS.has(key.toLowerCase())) return false;
  if (Array.isArray(value)) return value.map((item) => disableDeferredMcpCapabilities(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = disableDeferredMcpCapabilities(childValue, childKey);
  }
  return out;
}

export function readMemberMcpConfig(memberId: string): Record<string, unknown> | null {
  const repo = getDatabase();
  return hasMcpConfiguration(`member:${memberId}`, repo) ? readMcpConfiguration(`member:${memberId}`, repo) : null;
}

export function filterMcpConfigForServers(config: unknown, serverNames: string[]): Record<string, unknown> {
  const servers = getMcpServersObject(config);
  const allowed = new Set(serverNames);
  const mcpServers: Record<string, unknown> = {};
  for (const name of getMcpServerNames(config)) {
    if (allowed.has(name)) mcpServers[name] = disableDeferredMcpCapabilities(servers[name]);
  }
  const out: Record<string, unknown> = { mcpServers };
  if (isRecord(config) && isRecord(config.settings)) out.settings = disableDeferredMcpCapabilities(config.settings);
  return out;
}

export type McpStatusCache = Record<string, McpServerAvailability & { configHash?: string }>;

type Field = readonly [key: string, column: string, type: "string" | "number" | "boolean"];

const serverFields: readonly Field[] = [
  ["command","command","string"], ["url","url","string"], ["cwd","cwd","string"],
  ["bearerToken","bearer_token","string"], ["bearerTokenEnv","bearer_token_env","string"], ["lifecycle","lifecycle","string"],
  ["idleTimeout","idle_timeout","number"], ["requestTimeoutMs","request_timeout_ms","number"],
  ["exposeResources","expose_resources","boolean"], ["debug","debug","boolean"],
];

const settingFields: readonly Field[] = [
  ["toolPrefix","tool_prefix","string"], ["idleTimeout","idle_timeout","number"], ["requestTimeoutMs","request_timeout_ms","number"],
  ["directTools","direct_tools","boolean"], ["disableProxyTool","disable_proxy_tool","boolean"], ["autoAuth","auto_auth","boolean"],
  ["sampling","sampling","boolean"], ["samplingAutoApprove","sampling_auto_approve","boolean"], ["elicitation","elicitation","boolean"],
  ["authRequiredMessage","auth_required_message","string"],
];

const oauthFields: readonly Field[] = [
  ["grantType","grant_type","string"], ["clientId","client_id","string"], ["clientSecret","client_secret","string"],
  ["scope","scope","string"], ["redirectUri","redirect_uri","string"], ["clientName","client_name","string"], ["clientUri","client_uri","string"],
];

function extract(source: Record<string, unknown>, fields: readonly Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.map(([key,column,type]) => {
    const value=source[key]; delete source[key];
    if (value !== undefined && (typeof value !== type || type === "number" && !Number.isFinite(value))) throw new Error("Invalid MCP field");
    return [column,value === undefined ? null : type === "boolean" ? Number(value) : value];
  }));
}

function restore(row: Record<string, unknown>, fields: readonly Field[]): Record<string, unknown> {
  return defined(Object.fromEntries(fields.map(([key,column,type])=>[key,row[column] === null ? undefined : type === "boolean" ? !!row[column] : row[column]])));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v=>typeof v !== "string")) throw new Error("Invalid MCP string list");
  return value;
}

/** Internal configuration API, including secret-bearing transport and OAuth fields. */
export function hasMcpConfiguration(ownerId: string = "global", db: Database = getDatabase()): boolean { return !!db.get("SELECT owner_id FROM mcp_config WHERE owner_id=?",ownerId); }

function insertMcpFields(table: string, fields: Record<string, unknown>, db: Database = getDatabase()): void {
    // Identifiers are fixed repository constants, never configuration input.
    db.run(`INSERT INTO ${table} (${Object.keys(fields).join(",")}) VALUES (${Object.keys(fields).map(()=>"?").join(",")})`,...Object.values(fields));
  }

export function readMcpConfiguration(ownerId: string = "global", db: Database = getDatabase()): Record<string, unknown> {
  return db.transaction(() => {
    const root=db.get<any>("SELECT * FROM mcp_config WHERE owner_id=?",ownerId);
    if (!root) return {mcpServers:{}};
    const servers=Object.fromEntries(db.all<any>("SELECT * FROM mcp_servers WHERE owner_id=? ORDER BY position",ownerId).map(s=>{
      const values=db.all<any>("SELECT * FROM mcp_server_values WHERE owner_id=? AND server_name=?",ownerId,s.name);
      const args=db.all<{value:string}>("SELECT value FROM mcp_server_args WHERE owner_id=? AND server_name=? ORDER BY position",ownerId,s.name).map(a=>a.value);
      const tools=db.all<any>("SELECT * FROM mcp_server_tools WHERE owner_id=? AND server_name=? ORDER BY position",ownerId,s.name);
      const env=Object.fromEntries(values.filter(v=>v.kind==='env').map(v=>[v.name,v.value]));
      const headers=Object.fromEntries(values.filter(v=>v.kind==='headers').map(v=>[v.name,v.value]));
      const exclude=tools.filter(t=>t.kind==='exclude').map(t=>t.name);
      const oauth=db.get<any>("SELECT * FROM mcp_oauth_config WHERE owner_id=? AND server_name=?",ownerId,s.name);
      return [s.name,{
        ...parseObject(s.extension_json),...restore(s,serverFields),
        ...defined({auth:s.auth === null ? undefined : s.auth === "disabled" ? false : s.auth,
          directTools:s.direct_tools === null ? undefined : s.direct_tools === "list" ? tools.filter(t=>t.kind==='direct').map(t=>t.name) : s.direct_tools === "enabled"}),
        ...(oauth ? {oauth:oauth.enabled ? {...parseObject(oauth.extension_json),...restore(oauth,oauthFields)} : false} : {}),
        ...(args.length ? {args}:{}),...(Object.keys(env).length ? {env}:{}),...(Object.keys(headers).length ? {headers}:{}),...(exclude.length ? {excludeTools:exclude}:{}),
      }];
    }));
    const imports=db.all<{kind:string}>("SELECT kind FROM mcp_imports WHERE owner_id=? ORDER BY position",ownerId).map(r=>r.kind);
    return {
      ...parseObject(root.extension_json),mcpServers:servers,...(imports.length ? {imports}:{}),
      ...(root.settings_extension_json === null ? {} : {settings:{
        ...parseObject(root.settings_extension_json),...restore(root,settingFields),
        ...defined({outputGuard:root.output_guard === null ? undefined : root.output_guard === "custom"
          ? defined({maxBytes:root.output_guard_max_bytes,maxLines:root.output_guard_max_lines,detailsMaxBytes:root.output_guard_details_max_bytes}) : root.output_guard === "enabled"}),
      }}),
    };
  }, "deferred");
}

export function importMemberMcpConfiguration(memberId: string, config: Record<string, unknown>, db: Database = getDatabase()): void {
    importMcpConfiguration(config, `member:${memberId}`, db);
  }

export function importMcpConfiguration(config: Record<string, unknown>, ownerId: string = "global", db: Database = getDatabase()): void {
    const {mcpServers={},settings,imports,...extension}=config;
    objectJson(mcpServers);
    const settingsObject=settings === undefined ? {} : {...parseObject(objectJson(settings))};
    const {outputGuard}=settingsObject;delete settingsObject.outputGuard;
    const settingsColumns=extract(settingsObject,settingFields);
    const guard=typeof outputGuard === "object" && outputGuard !== null ? {...parseObject(objectJson(outputGuard))} : {};
    if (outputGuard === null || outputGuard !== undefined && typeof outputGuard !== "object" && typeof outputGuard !== "boolean") throw new Error("Invalid MCP output guard");
    const guardColumns=extract(guard,[["maxBytes","output_guard_max_bytes","number"],["maxLines","output_guard_max_lines","number"],["detailsMaxBytes","output_guard_details_max_bytes","number"]]);
    if (Object.keys(guard).length) throw new Error("Unknown MCP output guard field");
    if (imports !== undefined && !stringArray(imports).length) extension.imports=[];
    db.transaction(tx=>{
      tx.run("DELETE FROM mcp_config WHERE owner_id=?",ownerId);
      insertMcpFields("mcp_config",{owner_id:ownerId,extension_json:objectJson(extension),settings_extension_json:settings === undefined ? null : objectJson(settingsObject),...settingsColumns,
        output_guard:outputGuard === undefined ? null : typeof outputGuard === "object" ? "custom" : outputGuard ? "enabled" : "disabled",...guardColumns}, db);
      if (imports !== undefined) stringArray(imports).forEach((kind,i)=>tx.run("INSERT INTO mcp_imports VALUES (?,?,?)",ownerId,i,kind));
      Object.entries(mcpServers as Record<string,unknown>).forEach(([name,value],position)=>{
        const {args,env,headers,auth,directTools,excludeTools,oauth,...opaque}=parseObject(objectJson(value));
        const columns=extract(opaque,serverFields);
        if (auth !== undefined && auth !== false && auth !== "oauth" && auth !== "bearer") throw new Error("Invalid MCP auth mode");
        if (directTools !== undefined && typeof directTools !== "boolean") stringArray(directTools);
        if (args !== undefined && !stringArray(args).length) opaque.args=[];
        if (excludeTools !== undefined && !stringArray(excludeTools).length) opaque.excludeTools=[];
        for (const [kind,values] of Object.entries({env,headers})) if (values !== undefined) {
          objectJson(values);
          if (Object.values(values as object).some(v=>typeof v !== "string")) throw new Error("Invalid MCP environment or headers");
          if (!Object.keys(values as object).length) opaque[kind]={};
        }
        insertMcpFields("mcp_servers",{owner_id:ownerId,name,position,...columns,auth:auth === false ? "disabled" : auth ?? null,
          direct_tools:directTools === undefined ? null : Array.isArray(directTools) ? "list" : directTools ? "enabled" : "disabled",extension_json:objectJson(opaque)}, db);
        if (args !== undefined) stringArray(args).forEach((a,i)=>tx.run("INSERT INTO mcp_server_args VALUES (?,?,?,?)",ownerId,name,i,a));
        for (const [kind,values] of Object.entries({env,headers})) for (const [key,v] of Object.entries(values ?? {})) tx.run("INSERT INTO mcp_server_values VALUES (?,?,?,?,?)",ownerId,name,kind,key,v);
        for (const [kind,list] of [["direct",Array.isArray(directTools) ? directTools : []],["exclude",excludeTools ?? []]] as const) stringArray(list).forEach((tool,i)=>tx.run("INSERT INTO mcp_server_tools VALUES (?,?,?,?,?)",ownerId,name,kind,i,tool));
        if (oauth !== undefined) {
          const options=oauth === false ? {} : {...parseObject(objectJson(oauth))};
          const oauthColumns=extract(options,oauthFields);
          insertMcpFields("mcp_oauth_config",{owner_id:ownerId,server_name:name,enabled:Number(oauth !== false),...oauthColumns,extension_json:objectJson(options)}, db);
        }
      });
    });
  }

export function readMcpAvailability(db: Database = getDatabase()): McpStatusCache {
    return Object.fromEntries(db.all<any>("SELECT * FROM mcp_status").map(s=>[s.server_name,{name:s.name,status:s.status,
      ...defined({checkedAt:s.checked_at,toolCount:s.tool_count,resourceCount:s.resource_count,error:s.error,configHash:s.config_hash})}]));
  }

export function importMcpAvailability(cache: McpStatusCache, db: Database = getDatabase()): void {
    db.transaction(tx=>{
      tx.run("DELETE FROM mcp_status");
      for (const [key,s] of Object.entries(cache)) tx.run("INSERT INTO mcp_status VALUES (?,?,?,?,?,?,?,?)",key,s.name,s.status,s.checkedAt ?? null,s.toolCount ?? null,s.resourceCount ?? null,s.error ?? null,s.configHash ?? null);
    });
  }

// Structural implementation of vendor/pi-mcp-adapter McpAuthStorage. Kept local
// because the vendored TS extension is loaded by the SDK, not compiled into dist.
// These secret-bearing records are internal storage/protocol types, not API DTOs.
export interface McpOauthEntry {
  tokens?: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };
  clientInfo?: {
    clientId: string; clientSecret?: string; clientIdIssuedAt?: number;
    clientSecretExpiresAt?: number; redirectUris?: string[];
  };
  codeVerifier?: string;
  oauthState?: string;
  serverUrl?: string;
}

export function mcpOauthServerKey(serverName: string): string {
  if (typeof serverName !== "string") throw new Error("Invalid MCP server name");
  return createHash("sha256").update(serverName, "utf8").digest("hex");
}

function validateKey(key: string): void {
  if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid MCP OAuth storage key");
}

function text(value: unknown, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error("Invalid MCP OAuth text field");
  return value;
}

function number(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid MCP OAuth numeric field");
  return value;
}

/** Pure decoder for the pinned adapter's tokens.json AuthEntry document.
 * No file lookup, schema initialization, fallback or import-on-read. */
export function decodeLegacyMcpOauthEntry(value: unknown): McpOauthEntry {
  const row = requireObject(value, "Invalid MCP OAuth record");
  const entry: McpOauthEntry = {};
  for (const key of ["serverUrl", "codeVerifier", "oauthState"] as const) {
    if (row[key] !== undefined) entry[key] = text(row[key]);
  }
  if (row.tokens !== undefined) {
    const tokens = requireObject(row.tokens, "Invalid MCP OAuth record");
    entry.tokens = {
      accessToken: text(tokens.accessToken, true)!,
      ...(tokens.refreshToken !== undefined ? { refreshToken: text(tokens.refreshToken) } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: number(tokens.expiresAt) } : {}),
      ...(tokens.scope !== undefined ? { scope: text(tokens.scope) } : {}),
    };
  }
  if (row.clientInfo !== undefined) {
    const client = requireObject(row.clientInfo, "Invalid MCP OAuth record");
    entry.clientInfo = {
      clientId: text(client.clientId, true)!,
      ...(client.clientSecret !== undefined ? { clientSecret: text(client.clientSecret) } : {}),
      ...(client.clientIdIssuedAt !== undefined ? { clientIdIssuedAt: number(client.clientIdIssuedAt) } : {}),
      ...(client.clientSecretExpiresAt !== undefined ? { clientSecretExpiresAt: number(client.clientSecretExpiresAt) } : {}),
    };
    if (client.redirectUris !== undefined) {
      if (!Array.isArray(client.redirectUris)) throw new Error("Invalid MCP OAuth redirect URIs");
      entry.clientInfo.redirectUris = client.redirectUris.map((uri) => text(uri, true)!);
    }
  }
  // Avoid silently accepting the unrelated, flat OAuthTokens format of the
  // unused oauth-handler helper as an empty AuthEntry.
  if ("access_token" in row) throw new Error("Unsupported flat MCP OAuth token file; explicit conversion required");
  return entry;
}

export function readMcpOauthEntry(serverName: string, db: Database = getDatabase()): McpOauthEntry | undefined {
    // A coherent snapshot across normalized tables, even with another connection.
    return db.transaction(() => readMcpOauthKey(mcpOauthServerKey(serverName), db), "deferred");
  }

function readMcpOauthKey(key: string, db: Database = getDatabase()): McpOauthEntry | undefined {
    const row = db.get<{ server_url: string | null; code_verifier: string | null; oauth_state: string | null }>(
      "SELECT server_url, code_verifier, oauth_state FROM mcp_oauth_entries WHERE server_key = ?", key);
    if (!row) return undefined;
    const result: McpOauthEntry = {};
    if (row.server_url !== null) result.serverUrl = row.server_url;
    if (row.code_verifier !== null) result.codeVerifier = row.code_verifier;
    if (row.oauth_state !== null) result.oauthState = row.oauth_state;
    const tokens = db.get<{ access_token: string; refresh_token: string | null; expires_at: number | null; scope: string | null }>(
      "SELECT access_token, refresh_token, expires_at, scope FROM mcp_oauth_tokens WHERE server_key = ?", key);
    if (tokens) {
      result.tokens = { accessToken: tokens.access_token };
      if (tokens.refresh_token !== null) result.tokens.refreshToken = tokens.refresh_token;
      if (tokens.expires_at !== null) result.tokens.expiresAt = tokens.expires_at;
      if (tokens.scope !== null) result.tokens.scope = tokens.scope;
    }
    const client = db.get<{ client_id: string; client_secret: string | null; client_id_issued_at: number | null; client_secret_expires_at: number | null; has_redirect_uris: number }>(
      "SELECT client_id, client_secret, client_id_issued_at, client_secret_expires_at, has_redirect_uris FROM mcp_oauth_clients WHERE server_key = ?", key);
    if (client) {
      result.clientInfo = { clientId: client.client_id };
      if (client.client_secret !== null) result.clientInfo.clientSecret = client.client_secret;
      if (client.client_id_issued_at !== null) result.clientInfo.clientIdIssuedAt = client.client_id_issued_at;
      if (client.client_secret_expires_at !== null) result.clientInfo.clientSecretExpiresAt = client.client_secret_expires_at;
      if (client.has_redirect_uris) result.clientInfo.redirectUris = db.all<{ uri: string }>(
        "SELECT uri FROM mcp_oauth_redirect_uris WHERE server_key = ? ORDER BY position", key).map((item) => item.uri);
    }
    return result;
  }

export function writeMcpOauthEntry(serverName: string, entry: McpOauthEntry, db: Database = getDatabase()): void {
    importHashedMcpOauthEntry(mcpOauthServerKey(serverName), entry, db);
  }

export function deleteMcpOauthEntry(serverName: string, db: Database = getDatabase()): void {
    db.run("DELETE FROM mcp_oauth_entries WHERE server_key = ?", mcpOauthServerKey(serverName));
  }

export function importHashedMcpOauthEntry(serverKey: string, input: McpOauthEntry, db: Database = getDatabase()): void {
    validateKey(serverKey);
    const entry = decodeLegacyMcpOauthEntry(input);
    db.transaction(() => {
      db.run(`INSERT INTO mcp_oauth_entries(server_key, server_url, code_verifier, oauth_state) VALUES (?, ?, ?, ?)
        ON CONFLICT(server_key) DO UPDATE SET server_url=excluded.server_url, code_verifier=excluded.code_verifier, oauth_state=excluded.oauth_state`,
        serverKey, entry.serverUrl ?? null, entry.codeVerifier ?? null, entry.oauthState ?? null);
      db.run("DELETE FROM mcp_oauth_tokens WHERE server_key = ?", serverKey);
      db.run("DELETE FROM mcp_oauth_clients WHERE server_key = ?", serverKey);
      if (entry.tokens) {
        const tokens = entry.tokens;
        db.run("INSERT INTO mcp_oauth_tokens VALUES (?, ?, ?, ?, ?)", serverKey,
          tokens.accessToken, tokens.refreshToken ?? null, tokens.expiresAt ?? null, tokens.scope ?? null);
      }
      if (entry.clientInfo) {
        const client = entry.clientInfo;
        db.run("INSERT INTO mcp_oauth_clients VALUES (?, ?, ?, ?, ?, ?)", serverKey,
          client.clientId, client.clientSecret ?? null, client.clientIdIssuedAt ?? null,
          client.clientSecretExpiresAt ?? null, client.redirectUris === undefined ? 0 : 1);
        client.redirectUris?.forEach((uri, position) => {
          db.run("INSERT INTO mcp_oauth_redirect_uris VALUES (?, ?, ?)", serverKey, position, uri);
        });
      }
    });
  }

/** Synchronous credential capability, with stable identity per explicitly supplied database. */
export interface McpCredentialStore {
  read(serverName: string): McpOauthEntry | undefined;
  write(serverName: string, entry: McpOauthEntry): void;
  remove(serverName: string): void;
  transaction<T>(operation: () => T): T;
}

const storages = new WeakMap<Database, McpCredentialStore>();

export function createMcpOauthStorage(db: Database): McpCredentialStore {
  let storage = storages.get(db);
  if (!storage) {
    storage = { read: name => readMcpOauthEntry(name, db), write: (name, entry) => writeMcpOauthEntry(name, entry, db),
      remove: name => deleteMcpOauthEntry(name, db), transaction: operation => db.transaction(operation) };
    storages.set(db, storage);
  }
  return storage;
}
