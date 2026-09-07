/**
 * Codex HTTP session-id inheritance wrappers (fork prefix-cache reuse):
 * - rewrites session-id ONLY for requests carrying a registered child id
 * - leaves parent/sibling/unrelated traffic untouched (x-client-request-id kept)
 * - removes wrappers when the last registration is released
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const fetchOriginal = globalThis.fetch;

class RecordingWebSocket {
  static lastCtorArgs: any[] = [];
  constructor(...args: any[]) {
    RecordingWebSocket.lastCtorArgs.push(args);
  }
}
const wsOriginal = globalThis.WebSocket;
globalThis.WebSocket = RecordingWebSocket as any;

let mod: typeof import("../../src/engine/runtime/codex-header-inheritance.js");
let baseFetch: any;

beforeEach(async () => {
  vi.resetModules();
  baseFetch = vi.fn(async () => new Response("{}"));
  globalThis.fetch = baseFetch;
  globalThis.WebSocket = RecordingWebSocket as any;
  RecordingWebSocket.lastCtorArgs = [];
  mod = await import("../../src/engine/runtime/codex-header-inheritance.js");
});

afterEach(() => {
  globalThis.fetch = fetchOriginal;
  globalThis.WebSocket = wsOriginal;
});

function outgoingHeaders(): HeadersInit {
  return new Headers({
    "session-id": "child-sdk-session-id",
    "x-client-request-id": "child-sdk-session-id",
    authorization: "Bearer test",
  });
}

describe("codex session-id header inheritance", () => {
  it("rewrites session-id for a registered child request and keeps other headers", async () => {
    const reg = mod.registerCodexSessionHeaderInheritance("child-sdk-session-id", "parent-sdk-session-id");
    expect(reg).not.toBeNull();
    await fetch("https://api.example.com/v1/responses", { method: "POST", headers: outgoingHeaders(), body: "{}" });
    const [input, init] = baseFetch.mock.calls.at(-1);
    const sent = init.headers as Headers;
    expect(sent.get("session-id")).toBe("parent-sdk-session-id");
    expect(sent.get("x-client-request-id")).toBe("child-sdk-session-id");
    expect(sent.get("authorization")).toBe("Bearer test");
    reg!.release();
  });

  it("passes unrelated session ids and headerless requests through untouched", async () => {
    const reg = mod.registerCodexSessionHeaderInheritance("child-sdk-session-id", "parent-sdk-session-id");
    await fetch("https://api.example.com/v1/responses", {
      method: "POST",
      headers: new Headers({ "session-id": "someone-else", "x-client-request-id": "someone-else" }),
      body: "{}",
    });
    const [, init] = baseFetch.mock.calls.at(-1);
    expect((init.headers as Headers).get("session-id")).toBe("someone-else");
    // no init.headers → passthrough without inspection
    await fetch("https://api.example.com/other");
    const [input2, init2] = baseFetch.mock.calls.at(-1);
    expect(init2).toBeUndefined();
    reg!.release();
  });

  it("after release, the child's own id is sent again and wrappers are removed", async () => {
    const reg = mod.registerCodexSessionHeaderInheritance("child-sdk-session-id", "parent-sdk-session-id");
    reg!.release();
    await fetch("https://api.example.com/v1/responses", { method: "POST", headers: outgoingHeaders(), body: "{}" });
    const [, init] = baseFetch.mock.calls.at(-1);
    // wrapper removed: the test mock receives the child's own id untouched
    expect(globalThis.fetch).toBe(baseFetch);
    expect(init.headers.get("session-id")).toBe("child-sdk-session-id");
  });

  it("websocket constructor rewrites session-id only for the registered child", async () => {
    const reg = mod.registerCodexSessionHeaderInheritance("child-sdk-session-id", "parent-sdk-session-id");
    new (globalThis.WebSocket as any)("wss://api.example.com/v1/ws", {
      headers: { "session-id": "child-sdk-session-id", "x-client-request-id": "child-sdk-session-id" },
    });
    new (globalThis.WebSocket as any)("wss://api.example.com/v1/ws", {
      headers: { "session-id": "someone-else" },
    });
    expect(RecordingWebSocket.lastCtorArgs[0][1].headers["session-id"]).toBe("parent-sdk-session-id");
    expect(RecordingWebSocket.lastCtorArgs[0][1].headers["x-client-request-id"]).toBe("child-sdk-session-id");
    expect(RecordingWebSocket.lastCtorArgs[1][1].headers["session-id"]).toBe("someone-else");
    reg!.release();
  });

  it("rejects nonsensical registrations", () => {
    expect(mod.registerCodexSessionHeaderInheritance("", "parent")).toBeNull();
    expect(mod.registerCodexSessionHeaderInheritance("child", "")).toBeNull();
    expect(mod.registerCodexSessionHeaderInheritance("same", "same")).toBeNull();
  });
});
