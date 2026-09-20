import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "../../web/node_modules/react/index.js";

const api = vi.hoisted(() => ({ getMemberSystemPrompt: vi.fn() }));
vi.mock("../../web/src/api/client", () => ({
  getMemberDetail: vi.fn(),
  getMemberScopes: vi.fn(),
  getAvailableModels: vi.fn(),
  patchGlobalMember: vi.fn(),
  deleteGlobalMember: vi.fn(),
  getMemberProfile: vi.fn(),
  getMemberSkills: vi.fn(),
  getMemberStats: vi.fn(),
  getMemberSystemPrompt: api.getMemberSystemPrompt,
  getMemberAssets: vi.fn(),
  getMemberScopedStats: vi.fn(),
  getConversationSession: vi.fn(),
  memberAction: vi.fn(),
  sendDmMessage: vi.fn(),
}));

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
  setAttribute(key: string, value: string) { this.attributes[key] = String(value); }
  setAttributeNS(_namespace: string, key: string, value: string) { this.setAttribute(key, value); }
  removeAttribute(key: string) { delete this.attributes[key]; }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  get props(): any { return (this as any)[Object.keys(this).find((key) => key.startsWith("__reactProps$"))!]; }
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

let createRoot: typeof import("../../web/node_modules/react-dom/client.js").createRoot;
let SystemPromptSection: typeof import("../../web/src/components/member-float").SystemPromptSection;
let root: ReturnType<typeof createRoot>;
let container: HostNode;
const member = { memberId: "mem_prompt_ui" } as any;
const scope = { scopeId: "dm:mem_prompt_ui" } as any;
function nodes(node = container): HostNode[] { return [node, ...node.childNodes.flatMap((child) => nodes(child))]; }
function hasCopyButton() { return nodes().some((node) => node.tagName === "BUTTON" && node.textContent.includes("Copy")); }
async function render(liveStatus: string) {
  await act(async () => root.render(createElement(SystemPromptSection, { member, scope, liveStatus })));
}

beforeAll(async () => {
  vi.stubGlobal("document", documentHost);
  vi.stubGlobal("window", {
    document: documentHost,
    HTMLElement: HostNode,
    HTMLIFrameElement: class {},
    setTimeout: (...args: any[]) => (globalThis.setTimeout as any)(...args),
    clearTimeout: (...args: any[]) => (globalThis.clearTimeout as any)(...args),
    setInterval: (...args: any[]) => (globalThis.setInterval as any)(...args),
    clearInterval: (...args: any[]) => (globalThis.clearInterval as any)(...args),
    addEventListener() {}, removeEventListener() {},
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ createRoot } = await import("../../web/node_modules/react-dom/client.js"));
  ({ SystemPromptSection } = await import("../../web/src/components/member-float"));
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  api.getMemberSystemPrompt.mockReset();
  container = new HostNode();
  root = createRoot(container as any);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe("live system prompt panel", () => {
  it("switches between empty, live, idle and destroyed states without a page refresh", async () => {
    api.getMemberSystemPrompt.mockResolvedValueOnce({
      available: false,
      reason: "instance_not_running",
      scopeId: scope.scopeId,
    });
    await render("inactive");
    expect(container.textContent).toContain("Run this member to view its system prompt.");
    expect(hasCopyButton()).toBe(false);

    api.getMemberSystemPrompt.mockResolvedValueOnce({
      available: true,
      text: "SDK current prompt with cwd and skills",
      charCount: 38,
      scopeId: scope.scopeId,
      contractFingerprint: "0123456789abcdef",
    });
    await render("working");
    expect(container.textContent).toContain("SDK current prompt with cwd and skills");
    expect(hasCopyButton()).toBe(true);

    api.getMemberSystemPrompt.mockResolvedValueOnce({
      available: true,
      text: "SDK current prompt with cwd and skills",
      charCount: 38,
      scopeId: scope.scopeId,
      contractFingerprint: "0123456789abcdef",
    });
    await render("idle");
    expect(container.textContent).toContain("SDK current prompt with cwd and skills");

    api.getMemberSystemPrompt.mockResolvedValueOnce({
      available: false,
      reason: "instance_not_running",
      scopeId: scope.scopeId,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(container.textContent).toContain("Run this member to view its system prompt.");
    expect(container.textContent).not.toContain("SDK current prompt with cwd and skills");
    expect(hasCopyButton()).toBe(false);
  });
});
