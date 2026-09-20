import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../web/node_modules/react/index.js";
import type { AgentInstance } from "../src/agent/instance.js";
import { instanceKey, instances } from "../src/agent/instance.js";
import { MockAgentHandle, resetMocks } from "./helpers/mock-runtime.js";
import {
  closeTestServer,
  createTestServer,
  jsonRequest,
  loginAndGetToken,
  setupTestWorkspace,
  type TestServer,
} from "./helpers/test-server.js";

setupTestWorkspace();

class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  attributes: Record<string, string> = {};
  style = {};
  value = "";
  private text = "";
  constructor(public tagName = "DIV", public ownerDocument: any = documentHost) {}
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get textContent(): string { return this.text + this.childNodes.map((node) => node.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.childNodes = []; }
  appendChild(node: HostNode) { node.parentNode?.removeChild(node); this.childNodes.push(node); node.parentNode = this; return node; }
  removeChild(node: HostNode) { this.childNodes.splice(this.childNodes.indexOf(node), 1); node.parentNode = null; return node; }
  insertBefore(node: HostNode, before: HostNode) { node.parentNode?.removeChild(node); this.childNodes.splice(this.childNodes.indexOf(before), 0, node); node.parentNode = this; return node; }
  setAttribute(key: string, value: string) { this.attributes[key] = String(value); if (key === "value") this.value = String(value); }
  setAttributeNS(_namespace: string, key: string, value: string) { this.setAttribute(key, value); }
  removeAttribute(key: string) { delete this.attributes[key]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
}
const documentHost: any = {
  nodeType: 9,
  addEventListener() {}, removeEventListener() {},
  createElement: (tag: string) => new HostNode(tag.toUpperCase()),
  createElementNS: (namespace: string, tag: string) => Object.assign(new HostNode(tag), { namespaceURI: namespace }),
  createTextNode: (text: string) => Object.assign(new HostNode("#text"), { nodeType: 3, textContent: text }),
};
documentHost.documentElement = new HostNode("HTML");
documentHost.body = new HostNode("BODY");

let server: TestServer;
let token: string;
let memberId: string;
let scopeId: string;
let createRoot: typeof import("../web/node_modules/react-dom/client.js").createRoot;
let ActiveToolsSection: typeof import("../web/src/components/member-scope.js").ActiveToolsSection;
const tool = {
  name: "canonical_tool",
  label: "Canonical Tool",
  description: "Rendered from the top-level tools DTO",
  source: "bossmode",
  parameters: { type: "object", properties: {} },
};

function liveInstance(handle: MockAgentHandle): AgentInstance {
  handle.getActiveTools = () => [tool];
  return {
    handle,
    activeSourceRef: scopeId,
    memberId,
    agentName: "dto-member",
    status: "idle",
    dispatchState: "idle",
    promptInFlight: false,
    hadErrorInTurn: false,
    lastTurnError: null,
    pendingErrorNotice: null,
    lastMessageEndWasLength: false,
    lengthContinuationPending: false,
    lengthContinuationAttempted: false,
    compacting: false,
    turnActive: false,
    sessionSources: { compiled: { agentPrompt: "", appendSystemPrompt: [] } },
    unsubscribe() {},
    eventBuffer: [],
    appliedModel: "fake:model",
    pendingReload: null,
  };
}

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("document", documentHost);
  vi.stubGlobal("window", {
    document: documentHost,
    HTMLElement: HostNode,
    HTMLIFrameElement: class {},
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener() {}, removeEventListener() {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  server = await createTestServer();
  token = await loginAndGetToken(server.port);
  const created = await jsonRequest(server.port, "POST", "/api/members", {
    token,
    body: { name: "dto-member" },
  });
  expect(created.status, created.body).toBe(200);
  memberId = JSON.parse(created.body).member.memberId;
  scopeId = `dm:${memberId}`;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const target = typeof input === "string" && input.startsWith("/")
      ? `http://127.0.0.1:${server.port}${input}`
      : input;
    return nativeFetch(target, init);
  });
  const client = await import("../web/src/api/client.js");
  client.setToken(token);
  ({ createRoot } = await import("../web/node_modules/react-dom/client.js"));
  ({ ActiveToolsSection } = await import("../web/src/components/member-scope.js"));
});

afterAll(async () => {
  instances.delete(instanceKey(memberId));
  resetMocks();
  await closeTestServer(server);
  vi.unstubAllGlobals();
});

describe("canonical conversation panel DTOs", () => {
  it("keeps tools, session, context and events as top-level HTTP contracts", async () => {
    instances.set(instanceKey(memberId), liveInstance(new MockAgentHandle("prompt")));
    const path = (suffix: string) => `/api/conversations/${encodeURIComponent(scopeId)}/${suffix}`;

    const toolsResponse = await jsonRequest(server.port, "GET", path("tools"), { token });
    expect(toolsResponse.status, toolsResponse.body).toBe(200);
    expect(JSON.parse(toolsResponse.body)).toEqual({
      sessionActive: true,
      tools: [tool],
      scopeId,
      memberId,
    });
    expect(JSON.parse(toolsResponse.body)).not.toHaveProperty("live");

    const sessionResponse = await jsonRequest(server.port, "GET", path("session"), { token });
    expect(sessionResponse.status, sessionResponse.body).toBe(200);
    expect(JSON.parse(sessionResponse.body)).toEqual({
      status: "idle",
      busy: { busy: false },
      contextUsage: null,
      scopeId,
      memberId,
      memberName: "dto-member",
    });

    const contextResponse = await jsonRequest(server.port, "GET", path("context-usage"), { token });
    expect(contextResponse.status, contextResponse.body).toBe(200);
    expect(JSON.parse(contextResponse.body)).toEqual({ supported: true, unavailable: true, scopeId });

    const eventsResponse = await jsonRequest(server.port, "GET", `${path("events")}?limit=20`, { token });
    expect(eventsResponse.status, eventsResponse.body).toBe(200);
    expect(JSON.parse(eventsResponse.body)).toEqual({ events: [], total: 0, hasMore: false, scopeId, memberId });
  });

  it("renders active tools through the real HTTP client without a legacy live wrapper", async () => {
    instances.set(instanceKey(memberId), liveInstance(new MockAgentHandle("prompt")));
    const container = new HostNode();
    const root = createRoot(container as any);
    try {
      await act(async () => {
        root.render(createElement(ActiveToolsSection, {
          roomId: scopeId,
          memberRef: memberId,
          status: "idle",
          reloadKey: 0,
          dmScope: { scopeId, memberId },
        }));
      });
      for (let attempt = 0; attempt < 20 && !container.textContent.includes(tool.name); attempt++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      }
      expect(container.textContent).toContain("canonical_tool");
      expect(container.textContent).toContain("Rendered from the top-level tools DTO");
      expect(container.textContent).not.toContain("No active session.");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
