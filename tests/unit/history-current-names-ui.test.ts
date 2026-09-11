import { memberTitleHints } from "../../web/src/utils/member-title-hints";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "../../web/node_modules/react/index.js";

// Real ReactDOM reconciliation on a minimal test-local host. Rich Markdown and
// browser layout are outside this fixture; author spans/quote state are real.
class HostNode {
  nodeType = 1;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  childNodes: HostNode[] = [];
  parentNode: HostNode | null = null;
  attributes: Record<string, string> = {};
  style = {};
  value = "";
  selected = false;
  multiple = false;
  private text = "";
  constructor(public tagName = "DIV", public ownerDocument: any = documentHost) {}
  get nodeName() { return this.tagName; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get options() { return this.childNodes.filter((node) => node.tagName === "OPTION"); }
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
  scrollIntoView() {}
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


vi.mock("../../web/src/components/Markdown", () => ({ Markdown: ({ content }: any) => content }));
let createRoot: typeof import("../../web/node_modules/react-dom/client.js").createRoot;
let MessageInput: typeof import("../../web/src/components/MessageInput").MessageInput;
let directory: typeof import("../../web/src/hooks/useMemberIdentityDirectory");
let MessageBubble: typeof import("../../web/src/components/MessageBubble").MessageBubble;
let profiles: typeof import("../../web/src/hooks/useMemberProfileRevision");
let root: ReturnType<typeof createRoot>;
let container: HostNode;
function nodes(node = container): HostNode[] { return [node, ...node.childNodes.flatMap((child) => nodes(child))]; }
function authorNames() { return nodes().filter(n => n.tagName === "SPAN" && n.props?.className?.includes("font-semibold")).map(n => n.textContent); }
async function render(props: any) { await act(async () => root.render(createElement(MessageBubble, props))); }
beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("document", documentHost);
  vi.stubGlobal("window", { document: documentHost, HTMLElement: HostNode, HTMLIFrameElement: class {}, setTimeout: (...args: any[]) => (globalThis.setTimeout as any)(...args), clearTimeout: globalThis.clearTimeout, setInterval: (...args: any[]) => (globalThis.setInterval as any)(...args), clearInterval: (...args: any[]) => (globalThis.clearInterval as any)(...args), addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ createRoot } = await import("../../web/node_modules/react-dom/client.js"));
  ({ MessageBubble } = await import("../../web/src/components/MessageBubble"));
  ({ MessageInput } = await import("../../web/src/components/MessageInput"));
  directory = await import("../../web/src/hooks/useMemberIdentityDirectory");
  profiles = await import("../../web/src/hooks/useMemberProfileRevision");
});
beforeEach(() => { profiles.clearCurrentMemberNames(); container = new HostNode(); root = createRoot(container as any); });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("current names in real rendered historical messages", () => {
  it("updates an already rendered author by ID without changing the historical body", async () => {
    const message = Object.freeze({ sender: "architect", senderMemberId: "mem_history_visible", content: "@architect literal history", time: "04:00" });
    await render(message);
    expect(authorNames()).toContain("architect");
    await act(async () => profiles.publishMemberProfileChanged({ type: "member:profile", memberId: message.senderMemberId, name: "言实", title: "Engineer" }));
    expect(authorNames()).toContain("言实");
    expect(authorNames()).not.toContain("architect");
    expect(container.textContent).toContain("@architect literal history");
    expect(message.sender).toBe("architect");
  });
  it("updates an existing quote author by ID while preserving its excerpt and anchor", async () => {
    const quote = Object.freeze({ seq: 5, messageId: "source", sender: "old-quote", senderMemberId: "mem_history_quote", excerpt: "@old-quote literal excerpt" });
    await render({ sender: "user", content: "reply", time: "04:01", quote });
    await act(async () => profiles.publishMemberProfileChanged({ type: "member:profile", memberId: quote.senderMemberId, name: "new-quote", title: null }));
    expect(authorNames()).toContain("new-quote");
    expect(container.textContent).toContain("@old-quote literal excerpt");
    expect(quote.sender).toBe("old-quote");
  });
  it("uses the initial directory for retained/removed-roster identities and never resolves an unknown author by reused name", async () => {
    profiles.seedCurrentMemberNames([{id:"mem_known",name:"current"},{id:"mem_reuse",name:"old"},{id:"mem_archived",name:"archived final"}], profiles.getMemberProfileRevision());
    await act(async () => root.render(createElement("div", null,
      ...[{sender:"old",senderMemberId:"mem_known"},{sender:"old",senderMemberId:"mem_reuse"},{sender:"old"},{sender:"old",senderMemberId:"mem_missing"},{sender:"former",senderMemberId:"mem_archived"}]
        .map((message,i)=>createElement(MessageBubble,{...message,content:"body",key:i})))));
    expect(authorNames()).toEqual(["current","old","old","old","archived final"]);
  });
  it("does not overwrite a newer profile event with an older directory response", async () => {
    const revision = profiles.getMemberProfileRevision();
    await render({sender:"original",senderMemberId:"mem_race",content:"body"});
    await act(async () => profiles.publishMemberProfileChanged({type:"member:profile",memberId:"mem_race",name:"new event",title:null}));
    await act(async () => profiles.seedCurrentMemberNames([{id:"mem_race",name:"stale response"}], revision));
    expect(authorNames()).toEqual(["new event"]);
    await act(async () => profiles.seedCurrentMemberNames([], revision));
    expect(authorNames()).toEqual(["new event"]);
    await act(async () => profiles.seedCurrentMemberNames([{id:"mem_race",name:"fresh response"}], profiles.getMemberProfileRevision()));
    expect(authorNames()).toEqual(["fresh response"]);
  });
  it("keeps a composer quote reactive without changing the text or reference", async () => {
    const quote = Object.freeze({seq:42,messageId:"retained-anchor",sender:"old draft",senderMemberId:"mem_draft",excerpt:"literal @old draft"});
    await act(async () => root.render(createElement(MessageInput,{onSend:vi.fn(),members:[],quote,draftKey:null})));
    await act(async () => profiles.publishMemberProfileChanged({type:"member:profile",memberId:"mem_draft",name:"new draft",title:null}));
    expect(container.textContent).toContain("Reply to new draft");
    expect(container.textContent).toContain("literal @old draft");
    expect(quote).toEqual({seq:42,messageId:"retained-anchor",sender:"old draft",senderMemberId:"mem_draft",excerpt:"literal @old draft"});
  });
  it("keeps human labels and clearable directory state separate from historical facts", async () => {
    profiles.seedCurrentMemberNames([{id:"mem_clear",name:"current"}],profiles.getMemberProfileRevision());
    await render({sender:"user",content:"user body"});
    expect(authorNames()).toEqual(["you"]);
    await render({sender:"recorded",senderMemberId:"mem_clear",content:"body"});
    expect(authorNames()).toEqual(["current"]);
    await act(async()=>profiles.clearCurrentMemberNames());
    expect(authorNames()).toEqual(["recorded"]);
    await render({sender:"system",content:"system notice"});
    expect(authorNames()).toEqual([]);
    expect(container.textContent).toContain("system notice");
  });
  it("renders current titles in open mention options and removes cleared titles without template fallback", async () => {
    const members = [
      {name:"言实",title:"工程师",agentTemplate:"architect"},
      {name:"untitled",title:null,agentTemplate:"general"},
    ];
    const props = () => ({onSend:vi.fn(),members:members.map(m=>m.name),memberHints:memberTitleHints(members),draftKey:null});
    await act(async()=>root.render(createElement(MessageInput,props())));
    const input = nodes().find(n=>n.tagName==="TEXTAREA")!;
    await act(async()=>input.props.onChange({target:{value:"@"}}));
    const options = () => nodes().filter(n=>n.props?.role==="option").map(n=>n.textContent);
    expect(options()).toEqual(["@allactivate all members","@言实工程师","@untitled"]);
    members[0].title="Reviewer";
    await act(async()=>root.render(createElement(MessageInput,props())));
    expect(options()).toContain("@言实Reviewer");
    members[0].title=null;
    await act(async()=>root.render(createElement(MessageInput,props())));
    expect(options()).toEqual(["@allactivate all members","@言实","@untitled"]);
    expect(input.value).toBe("@");
  });
  it("keeps literal titles and empty hints independent of names or retired template labels", () => {
    const members = [
      {name:"pm",title:"pm exact TITLE",agentTemplate:"architect"},
      {name:"empty",title:"",agentTemplate:"general"},
      {name:"missing",agentTemplate:"qa"},
      {name:"__proto__",title:null},
    ];
    const hints=memberTitleHints(members);
    expect(hints.pm).toBe("pm exact TITLE");
    expect(hints.empty).toBe("");expect(hints.missing).toBe("");
    expect(Object.hasOwn(hints,"__proto__")).toBe(true);expect(hints["__proto__"]).toBe("");
  });
  it("shares directory loading, retains names on failure, retries and reloads on reconnect", async () => {
    vi.useFakeTimers({toFake:["setTimeout","setInterval","clearTimeout","clearInterval"]});
    const ok = (name: string) => ({ok:true,json:async()=>({members:[{id:"mem_directory",name}]})});
    const fetchMock = vi.fn().mockResolvedValueOnce(ok("initial directory")).mockRejectedValueOnce(new Error("fixture offline")).mockResolvedValueOnce(ok("retry name")).mockResolvedValueOnce(ok("disconnect read")).mockResolvedValueOnce(ok("reconnect name"));
    vi.stubGlobal("fetch",fetchMock); const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
    function View({connected}: {connected:boolean}) {
      directory.useMemberIdentityDirectory(connected);
      return createElement("div",null,...Array.from({length:3},(_,key)=>createElement(MessageBubble,{key,sender:"recorded",senderMemberId:"mem_directory",content:"body"})));
    }
    await act(async()=>root.render(createElement(View,{connected:true})));
    expect(authorNames()).toEqual(Array(3).fill("initial directory")); expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
    expect(warning).toHaveBeenCalledTimes(1); expect(authorNames()).toEqual(Array(3).fill("initial directory"));
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
    expect(authorNames()).toEqual(Array(3).fill("retry name"));
    await act(async()=>root.render(createElement(View,{connected:false})));
    expect(authorNames()).toEqual(Array(3).fill("disconnect read"));
    await act(async()=>root.render(createElement(View,{connected:true})));
    expect(authorNames()).toEqual(Array(3).fill("reconnect name"));
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.every(([url])=>url==="/api/members/identities")).toBe(true);
  });

});
