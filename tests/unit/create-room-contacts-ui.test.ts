import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "../../web/node_modules/react/index.js";
import type { MemberInfo } from "../../web/src/api/client";

// No DOM/test-renderer dependency is installed. This test-local host supplies only
// ReactDOM's element operations; real React hooks/effects/reconciliation run below.
// Handlers are invoked from committed React props, not native browser events.
// Sheet focus/overlay behavior and browser layout remain integration acceptance.
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

vi.mock("../../web/src/components/Sheet", () => ({ Sheet: ({ children }: any) => children }));

let createRoot: typeof import("../../web/node_modules/react-dom/client.js").createRoot;
let CreateRoomDialog: typeof import("../../web/src/components/CreateRoomDialog").CreateRoomDialog;
let MemberPickerDialog: typeof import("../../web/src/components/MemberPickerDialog").MemberPickerDialog;
let api: typeof import("../../web/src/api/client");
let root: ReturnType<typeof createRoot>;
let container: HostNode;
let fetchMock: ReturnType<typeof vi.fn>;
const contacts: MemberInfo[] = [
  { id: "mem-a", name: " 言 实 `研发` ", agent: "historical-label", thinkingLevel: "medium", title: "Engineer", avatar: "🐟" },
  { id: "mem-b", name: "mem-a", agent: "historical-label", thinkingLevel: "medium" },
  { id: "mem-c", name: " 言 实 `研发` ", agent: "historical-label", thinkingLevel: "medium" },
];
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nodes(node = container): HostNode[] { return [node, ...node.childNodes.flatMap((child) => nodes(child))]; }
function button(text: string) {
  const result = nodes().find((node) => node.tagName === "BUTTON" && node.textContent === text);
  expect(result, `button ${text}`).toBeDefined();
  return result!;
}
async function click(node: HostNode) { await act(async () => { node.props.onClick(); }); }
async function render(element: ReturnType<typeof createElement>) { await act(async () => root.render(element)); }
async function nameRoom(name = " Product launch ") {
  await act(async () => nodes().find((node) => node.tagName === "INPUT")!.props.onChange({ target: { value: name } }));
}
async function pick(id: string) {
  await click(button(" Add member"));
  const row = nodes().find((node) => node.attributes["data-contact-id"] === id)!;
  expect(row).toBeDefined();
  await click(row);
}
async function submit() { await act(async () => nodes().find((node) => node.tagName === "FORM")!.props.onSubmit({ preventDefault() {} })); }
function selectedIds() { return nodes().filter((node) => node.attributes["data-member-id"]).map((node) => node.attributes["data-member-id"]); }

beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal("document", documentHost);
  vi.stubGlobal("window", { document: documentHost, HTMLElement: HostNode, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ({ createRoot } = await import("../../web/node_modules/react-dom/client.js"));
  ({ CreateRoomDialog } = await import("../../web/src/components/CreateRoomDialog"));
  ({ MemberPickerDialog } = await import("../../web/src/components/MemberPickerDialog"));
  api = await import("../../web/src/api/client");
});
beforeEach(() => {
  container = new HostNode();
  root = createRoot(container as any);
  fetchMock = vi.fn().mockResolvedValue(ok(contacts));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => { await act(async () => root.unmount()); });

describe("contacts room creation through React state and the HTTP client", () => {
  it("retains the sheet sections and validates name/selection without a request", async () => {
    const onSubmit = vi.fn();
    await render(createElement(CreateRoomDialog, { onClose: vi.fn(), onSubmit }));
    expect(container.textContent).toContain("Room details");
    expect(container.textContent).toContain("Create new members in Contacts first.");
    await submit();
    expect(container.textContent).toContain("Enter a Room name.");
    expect(container.textContent).toContain("Add at least one member.");
    await nameRoom();
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(nodes().filter((node) => node.tagName === "INPUT")).toHaveLength(1);
  });

  it("validates a blank room name even after a contact is selected", async () => {
    const onSubmit = vi.fn();
    await render(createElement(CreateRoomDialog, { onClose: vi.fn(), onSubmit }));
    await pick("mem-a");
    await nameRoom("   ");
    fetchMock.mockClear();
    await submit();
    expect(container.textContent).toContain("Enter a Room name.");
    expect(selectedIds()).toEqual(["mem-a"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("renders literal contact names, prevents duplicates and sends only stable IDs", async () => {
    const onClose = vi.fn();
    await render(createElement(CreateRoomDialog, { onClose, onSubmit: api.createRoom }));
    await nameRoom();
    await pick("mem-a");
    await click(button(" Add member"));
    const existing = nodes().find((node) => node.attributes["data-contact-id"] === "mem-a")!;
    expect(existing.props.disabled).toBe(true);
    await click(existing); // Defense also holds if a queued handler runs after selection.
    expect(selectedIds()).toEqual(["mem-a"]);
    await click(nodes().find((node) => node.attributes["data-contact-id"] === "mem-b")!);
    await pick("mem-c");
    expect(selectedIds()).toEqual(["mem-a", "mem-b", "mem-c"]);
    const options = nodes().filter((node) => node.tagName === "OPTION");
    expect(options.map((node) => [node.props.value, node.textContent])).toEqual(contacts.map((member) => [member.id, member.name]));
    expect(container.textContent).not.toContain("historical-label");
    expect(container.textContent).not.toContain("Edit");
    await act(async () => nodes().find((node) => node.tagName === "SELECT")!.props.onChange({ target: { value: "mem-b" } }));
    fetchMock.mockImplementation(async (url: string) => ok(url === "/api/members" ? contacts : { id: "room-1" }));
    await submit();
    const posts = fetchMock.mock.calls.filter(([, options]) => options.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe("/api/rooms");
    expect(JSON.parse(posts[0][1].body)).toEqual({ name: "Product launch", memberIds: ["mem-a", "mem-b", "mem-c"], leaderMemberId: "mem-b" });
    expect(fetchMock.mock.calls.every(([url]) => ["/api/members", "/api/rooms"].includes(url))).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves the leader to a remaining selection and clears it after removing the last", async () => {
    await render(createElement(CreateRoomDialog, { onClose: vi.fn(), onSubmit: vi.fn() }));
    await pick("mem-a");
    await pick("mem-b");
    await click(button(" Remove"));
    expect(nodes().find((node) => node.tagName === "SELECT")!.props.value).toBe("mem-b");
    await click(button(" Remove"));
    expect(selectedIds()).toEqual([]);
    expect(nodes().some((node) => node.tagName === "SELECT")).toBe(false);
    await pick("mem-c");
    expect(nodes().find((node) => node.tagName === "SELECT")!.props.value).toBe("mem-c");
  });

  it("retains room name, selections and leader after server error, and can retry", async () => {
    const onClose = vi.fn();
    await render(createElement(CreateRoomDialog, { onClose, onSubmit: api.createRoom }));
    await nameRoom();
    await pick("mem-a");
    await pick("mem-b");
    await act(async () => nodes().find((node) => node.tagName === "SELECT")!.props.onChange({ target: { value: "mem-b" } }));
    fetchMock.mockImplementation(async (url: string) => url === "/api/members" ? ok(contacts) : { ok: false, status: 409, json: async () => ({ error: "Contact was removed" }) });
    await submit();
    expect(container.textContent).toContain("Contact was removed");
    expect(selectedIds()).toEqual(["mem-a", "mem-b"]);
    expect(nodes().find((node) => node.tagName === "SELECT")!.props.value).toBe("mem-b");
    expect(nodes().find((node) => node.tagName === "INPUT")!.props.value).toBe(" Product launch ");
    expect(onClose).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async (url: string) => ok(url === "/api/members" ? contacts : { id: "room-1" }));
    await submit();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects a stale contact before posting without silently replacing or dropping it", async () => {
    const onSubmit = vi.fn();
    await render(createElement(CreateRoomDialog, { onClose: vi.fn(), onSubmit }));
    await nameRoom();
    await pick("mem-a");
    fetchMock.mockResolvedValue(ok(contacts.slice(1)));
    await submit();
    expect(container.textContent).toContain("A selected contact is no longer available.");
    expect(selectedIds()).toEqual(["mem-a"]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit if contact refresh fails and retains the selection", async () => {
    const onSubmit = vi.fn();
    await render(createElement(CreateRoomDialog, { onClose: vi.fn(), onSubmit }));
    await nameRoom();
    await pick("mem-a");
    fetchMock.mockRejectedValue(new Error("Offline"));
    await submit();
    expect(container.textContent).toContain("Offline");
    expect(selectedIds()).toEqual(["mem-a"]);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("blocks duplicate submission while the request is in flight", async () => {
    const pending = deferred<void>();
    const onSubmit = vi.fn().mockReturnValue(pending.promise);
    await render(createElement(CreateRoomDialog, { onClose: vi.fn(), onSubmit }));
    await nameRoom();
    await pick("mem-a");
    const handler = nodes().find((node) => node.tagName === "FORM")!.props.onSubmit;
    let first: Promise<void>;
    await act(async () => { first = handler({ preventDefault() {} }); });
    expect(container.textContent).toContain("Creating…");
    expect(nodes().find((node) => node.tagName === "FIELDSET")!.props.disabled).toBe(true);
    await act(async () => handler({ preventDefault() {} }));
    expect(onSubmit).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(); await first!; });
  });
});

describe("current contact picker loading and recovery", () => {
  it("does not fetch while closed and closing without picking changes no selection", async () => {
    const onClose = vi.fn();
    const onPickMember = vi.fn();
    const props = { onClose, onPickMember, selectedMemberIds: [] };
    await render(createElement(MemberPickerDialog, { ...props, open: false }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
    await render(createElement(MemberPickerDialog, { ...props, open: true }));
    await click(nodes().find((node) => node.props?.["aria-label"] === "Close member picker")!);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPickMember).not.toHaveBeenCalled();
  });

  it("renders loading, error with Retry, and only then successful empty guidance", async () => {
    const pending = deferred<ReturnType<typeof ok>>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await render(createElement(MemberPickerDialog, { open: true, onClose: vi.fn(), onPickMember: vi.fn(), selectedMemberIds: [] }));
    expect(container.textContent).toContain("Loading contacts…");
    expect(container.textContent).not.toContain("No contacts yet.");
    await act(async () => pending.reject(new Error("offline")));
    expect(container.textContent).toContain("Couldn’t load contacts.");
    expect(container.textContent).not.toContain("No contacts yet.");
    fetchMock.mockResolvedValue(ok([]));
    await click(button("Retry"));
    expect(container.textContent).toContain("No contacts yet. Create a member in Contacts, then return here.");
    expect(container.textContent).not.toContain("Couldn’t load contacts.");
  });

  it("loads real choices after Retry and shows all-selected guidance", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await render(createElement(MemberPickerDialog, { open: true, onClose: vi.fn(), onPickMember: vi.fn(), selectedMemberIds: contacts.map((member) => member.id) }));
    await click(button("Retry"));
    expect(container.textContent).toContain("Every contact is already selected.");
    expect(nodes().filter((node) => node.attributes["data-contact-id"]).every((node) => node.props.disabled)).toBe(true);
    expect(container.textContent).toContain(contacts[0].name);
  });

  it("refreshes on reopening and ignores results from a closed picker", async () => {
    const old = deferred<ReturnType<typeof ok>>();
    fetchMock.mockReturnValueOnce(old.promise);
    const props = { onClose: vi.fn(), onPickMember: vi.fn(), selectedMemberIds: [] };
    await render(createElement(MemberPickerDialog, { ...props, open: true }));
    await render(createElement(MemberPickerDialog, { ...props, open: false }));
    fetchMock.mockResolvedValue(ok([contacts[1]]));
    await render(createElement(MemberPickerDialog, { ...props, open: true }));
    await act(async () => old.resolve(ok([contacts[0]])));
    expect(nodes().filter((node) => node.attributes["data-contact-id"]).map((node) => node.attributes["data-contact-id"])).toEqual(["mem-b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
