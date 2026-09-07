/**
 * Codex HTTP session-id inheritance for forked background child sessions.
 *
 * Evidence (qa/evidence-codex-cache-fields-20260907/RESULT.md): a forked child
 * keeps its own SDK session id; when the child's outgoing HTTP `session-id`
 * header carries the PARENT's value instead of its own, the first fork request
 * hits the prompt cache (~3840–4096 tokens vs 0). Only the `session-id` header
 * is rewritten — `x-client-request-id` and the SDK session id stay the child's.
 *
 * pi-ai sets `session-id` last in buildSSEHeaders/buildWebSocketHeaders, so
 * neither model.headers nor options.headers can override it. The only product
 * seam that covers BOTH transports is the outbound boundary: globalThis.fetch
 * (SSE) and globalThis.WebSocket (WS, resolved per call by getWebSocketConstructor
 * in openai-codex-responses.js). This module installs reference-counted wrappers
 * that rewrite the header ONLY for requests whose current `session-id` equals a
 * registered child id — parent, sibling, and unrelated traffic pass untouched.
 *
 * Wrappers are removed as soon as the last registration is released. If the
 * global slots are not writable (nonstandard runtime), registration reports
 * false and the child runs without inheritance (logged, never silently faked).
 */
import { logger } from "../../foundation/logger.js";

const SESSION_ID_HEADER = "session-id";

/** childSdkSessionId -> inherited parent session-id. */
const active = new Map<string, string>();

const fetchOriginal = globalThis.fetch;
const wsOriginal: (typeof globalThis)["WebSocket"] | undefined = globalThis.WebSocket;
let fetchInstalled = false;
let wsInstalled = false;

function inheritedFor(childSessionId: string | null): string | null {
  if (!childSessionId) return null;
  return active.get(childSessionId) ?? null;
}

function headersToPlain(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = String(value);
    return out;
  }
  for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  return out;
}

function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!init?.headers) return fetchOriginal(input as any, init);
  const headers = headersToPlain(init.headers);
  const inherit = inheritedFor(headers[SESSION_ID_HEADER] ?? null);
  if (!inherit) return fetchOriginal(input as any, init);
  const rewritten = new Headers(init.headers);
  rewritten.set(SESSION_ID_HEADER, inherit);
  return fetchOriginal(input as any, { ...init, headers: rewritten });
}

class WebSocketWithInheritance {
  constructor(url: any, options?: any) {
    const headers = options?.headers;
    const inherit = inheritedFor(headers?.[SESSION_ID_HEADER] ?? null);
    if (!headers || typeof headers !== "object" || !inherit) {
      return new (wsOriginal as any)(url, options);
    }
    const rewritten = { ...options, headers: { ...headers, [SESSION_ID_HEADER]: inherit } };
    return new (wsOriginal as any)(url, rewritten);
  }
}

function install(): boolean {
  let ok = true;
  if (!fetchInstalled) {
    try {
      globalThis.fetch = patchedFetch as typeof fetch;
      fetchInstalled = true;
    } catch (err) {
      logger.warn("runtime:pi-sdk", "codex session-id inheritance: fetch wrapper unavailable", { error: String(err) });
      ok = false;
    }
  }
  if (!wsInstalled && typeof wsOriginal === "function") {
    try {
      (globalThis as any).WebSocket = WebSocketWithInheritance;
      wsInstalled = true;
    } catch (err) {
      logger.warn("runtime:pi-sdk", "codex session-id inheritance: WebSocket wrapper unavailable", { error: String(err) });
    }
  }
  return ok;
}

function uninstallIfIdle(): void {
  if (active.size > 0) return;
  if (fetchInstalled) {
    globalThis.fetch = fetchOriginal;
    fetchInstalled = false;
  }
  if (wsInstalled && typeof wsOriginal === "function") {
    (globalThis as any).WebSocket = wsOriginal;
    wsInstalled = false;
  }
}

export interface CodexSessionHeaderRegistration {
  release(): void;
}

/**
 * Register one child session. Safe to call repeatedly for the same child
 * (map overwrite; release is idempotent). Returns null when the outbound
 * wrappers could not be installed — callers must treat that as "no
 * inheritance", never as success.
 */
export function registerCodexSessionHeaderInheritance(childSdkSessionId: string, parentSessionId: string): CodexSessionHeaderRegistration | null {
  if (!childSdkSessionId || !parentSessionId || childSdkSessionId === parentSessionId) return null;
  const installOk = install();
  if (!installOk && !fetchInstalled && active.size === 0) return null;
  active.set(childSdkSessionId, parentSessionId);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      active.delete(childSdkSessionId);
      uninstallIfIdle();
    },
  };
}
