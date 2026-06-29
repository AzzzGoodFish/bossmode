import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerAvailability } from "../shared/types.js";
import { sanitizeMcpError } from "../shared/mcp-settings.js";

const DEFAULT_TIMEOUT_MS = 10_000;

type ServerConfig = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error(`MCP availability check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function availability(name: string, status: McpServerAvailability["status"], extra: Partial<McpServerAvailability> = {}): McpServerAvailability {
  return { name, status, checkedAt: Date.now(), ...extra };
}

function buildHeaders(config: ServerConfig): HeadersInit | undefined {
  const headers: Record<string, string> = { ...(asStringRecord(config.headers) || {}) };
  const bearerToken = typeof config.bearerToken === "string" ? config.bearerToken : undefined;
  const bearerTokenEnv = typeof config.bearerTokenEnv === "string" ? process.env[config.bearerTokenEnv] : undefined;
  const token = bearerToken || bearerTokenEnv;
  if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;
  return Object.keys(headers).length ? headers : undefined;
}

async function listToolsWithTransport(transport: any): Promise<number> {
  const client = new Client({ name: "bossmode-mcp-check", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return Array.isArray(result.tools) ? result.tools.length : 0;
  } finally {
    try { await client.close(); } catch {}
    try { await transport.close?.(); } catch {}
  }
}

async function checkHttp(name: string, config: ServerConfig, timeoutMs: number): Promise<McpServerAvailability> {
  const urlText = typeof config.url === "string" ? config.url : "";
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return availability(name, "invalid-config", { error: "Invalid MCP server URL" });
  }
  const requestInit: RequestInit = { headers: buildHeaders(config) };

  const tryStreamable = async () => {
    const transport = new StreamableHTTPClientTransport(url, { requestInit });
    const toolCount = await listToolsWithTransport(transport);
    return availability(name, "available", { toolCount });
  };
  const trySse = async () => {
    const transport = new SSEClientTransport(url, { requestInit });
    const toolCount = await listToolsWithTransport(transport);
    return availability(name, "available", { toolCount });
  };

  try {
    return await withTimeout(tryStreamable(), timeoutMs);
  } catch (err) {
    if (err instanceof UnauthorizedError) return availability(name, "auth-required", { error: "Authentication required" });
    try {
      return await withTimeout(trySse(), timeoutMs);
    } catch (sseErr) {
      if (sseErr instanceof UnauthorizedError) return availability(name, "auth-required", { error: "Authentication required" });
      return availability(name, "unavailable", { error: sanitizeMcpError(sseErr, config) || sanitizeMcpError(err, config) });
    }
  }
}

async function checkStdio(name: string, config: ServerConfig, timeoutMs: number): Promise<McpServerAvailability> {
  const command = typeof config.command === "string" ? config.command.trim() : "";
  if (!command) return availability(name, "invalid-config", { error: "Missing stdio command" });
  const args = Array.isArray(config.args) ? config.args.map(String) : undefined;
  const env = asStringRecord(config.env);
  const cwd = typeof config.cwd === "string" ? config.cwd : undefined;
  let transport: StdioClientTransport | undefined;
  try {
    transport = new StdioClientTransport({ command, args, env, cwd, stderr: "ignore" });
    const toolCount = await withTimeout(listToolsWithTransport(transport), timeoutMs, () => {
      try { transport?.close(); } catch {}
    });
    return availability(name, "available", { toolCount });
  } catch (err) {
    try { await transport?.close(); } catch {}
    return availability(name, "unavailable", { error: sanitizeMcpError(err, config) });
  }
}

export async function checkMcpServerAvailability(name: string, serverConfig: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<McpServerAvailability> {
  const config = asRecord(serverConfig);
  if (typeof config.url === "string" && config.url.trim()) return checkHttp(name, config, timeoutMs);
  if (typeof config.command === "string" && config.command.trim()) return checkStdio(name, config, timeoutMs);
  return availability(name, "invalid-config", { error: "Server must define url or command" });
}
