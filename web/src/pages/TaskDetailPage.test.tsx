import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Task } from "../api/client";

// Hook-level component tests: exercise the page's real controls/effects/save
// handlers without a DOM or importing the rich markdown editor.
const runtime = vi.hoisted(() => ({
  frame: null as any,
  revision: 0,
  toast: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState(initial: any) {
    const frame = runtime.frame;
    const index = frame.cursor++;
    if (!(index in frame.state)) frame.state[index] = typeof initial === "function" ? initial() : initial;
    return [frame.state[index], (value: any) => {
      frame.state[index] = typeof value === "function" ? value(frame.state[index]) : value;
    }];
  },
  useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
    const frame = runtime.frame;
    const index = frame.cursor++;
    const previous = frame.deps[index];
    if (!deps || !previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
      frame.cleanup[index]?.();
      frame.effects.push(() => { frame.cleanup[index] = effect(); });
      frame.deps[index] = deps;
    }
  },
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useRef: () => ({ current: null }),
}));
vi.mock("../hooks/useMemberProfileRevision", () => ({ useMemberProfileRevision: () => runtime.revision }));
vi.mock("../components/dialogs", () => ({ useDialog: () => ({ toast: runtime.toast, confirm: runtime.confirm }) }));
vi.mock("../components/Markdown", () => ({ Markdown: () => null }));
vi.mock("../components/MarkdownField", () => ({ MarkdownField: () => null }));
vi.mock("../components/MobileTopBar", () => ({ MobileTopBar: () => null }));
vi.mock("../api/client", () => ({
  getTask: vi.fn(), updateTask: vi.fn(), createTask: vi.fn(),
  getRoom: vi.fn(), getContacts: vi.fn(), deleteTaskApi: vi.fn(), commentTask: vi.fn(),
}));
import { createTask, getContacts, getRoom, getTask, updateTask } from "../api/client";
import { TaskDetailPage, taskParticipantPatch, taskParticipantSelection } from "./TaskDetailPage";

type Element = ReactElement<any>;
function harness(render: () => Element) {
  const frame = { cursor: 0, state: [] as any[], deps: [] as any[], cleanup: [] as any[], effects: [] as (() => void)[] };
  return () => {
    frame.cursor = 0;
    runtime.frame = frame;
    const tree = render();
    frame.effects.splice(0).forEach((effect) => effect());
    return tree;
  };
}
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [tree, ...nodes(tree.props.children)];
}
function picker(tree: Element, name: string): Element {
  return nodes(tree).find((node) => typeof node.type === "function" && node.type.name === name)!;
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return typeof tree === "string" ? tree : tree?.props ? text(tree.props.children) : "";
}
function button(tree: Element, label: string): Element {
  return nodes(tree).find((node) => node.type === "button" && text(node).trim() === label)!;
}
function openPicker(element: Element) {
  const render = harness(() => (element.type as any)(element.props));
  const initial = render();
  nodes(initial).find((node) => node.type === "button")!.props.onClick();
  return render();
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const original: Task = {
  id: "task_one", roomId: "room_one", title: "Original", status: "todo", priority: "P1",
  assignee: "old", assigneeMemberId: "mem_one", subscribers: ["old", "user"], subscriberMemberIds: ["mem_one"],
  createdBy: "old", createdAt: 1, updatedAt: 1,
  comments: [{ id: "comment", author: "old", content: "History", createdAt: 1 }],
};
function page(taskId = "task_one") {
  return harness(() => TaskDetailPage({ roomId: "room_one", taskId, onBack: vi.fn() }));
}
function changeTitle(tree: Element) {
  nodes(tree).find((node) => node.props.placeholder === "Task title…" || node.props.placeholder === "Untitled")!.props.onChange({ target: { value: "Edited" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.revision = 0;
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(getRoom).mockResolvedValue({ id: "room_one", name: "Room", cwd: "", createdAt: 1, members: ["old", "other"], globalMemberIds: ["mem_one", "mem_two"] });
  vi.mocked(getContacts).mockResolvedValue({ contacts: [
    { memberId: "mem_one", name: "old" }, { memberId: "mem_two", name: "other" },
  ] } as any);
  vi.mocked(getTask).mockResolvedValue(original);
  vi.mocked(updateTask).mockResolvedValue(original);
  vi.mocked(createTask).mockResolvedValue(original);
});

describe("task editor stable participant selections", () => {
  it("keeps IDs through a pending roster refresh and shows renamed labels after it completes", async () => {
    const render = page(); render(); await settle();
    let tree = render();
    button(openPicker(picker(tree, "AssigneePicker")), "old✓").props.onClick();
    button(openPicker(picker(tree, "SubscribersPicker")), "other").props.onClick();
    let resolveContacts!: (value: any) => void;
    vi.mocked(getContacts).mockImplementationOnce(() => new Promise((resolve) => { resolveContacts = resolve; }));
    runtime.revision++;
    tree = render(); // Starts async refresh; old name has already been reused on the server.
    await button(tree, "Save").props.onClick();
    expect(vi.mocked(updateTask).mock.calls[0][2]).toMatchObject({ assignee: "mem_one", subscribers: ["mem_one", "user", "mem_two"] });
    resolveContacts({ contacts: [{ memberId: "mem_one", name: "renamed" }, { memberId: "mem_two", name: "old" }] });
    await settle(); tree = render();
    expect(picker(tree, "AssigneePicker").props).toMatchObject({ value: "mem_one", label: "renamed" });
    expect(text(openPicker(picker(tree, "SubscribersPicker")))).toContain("renamed, user");
    expect(picker(tree, "AssigneePicker").props.members).toEqual([{ id: "mem_one", name: "renamed" }, { id: "mem_two", name: "old" }]);
    // Created-by and comment authors remain historical, not live participant labels.
    expect(nodes(tree).filter((node) => node.props.name === "old")).toHaveLength(2);
    changeTitle(tree); await button(render(), "Save").props.onClick();
    expect(vi.mocked(updateTask).mock.calls[1][2]).not.toHaveProperty("assignee");
    expect(vi.mocked(updateTask).mock.calls[1][2]).not.toHaveProperty("subscribers");
  });

  it("does not rebind unresolved historical names on an unrelated save, even if a current member owns that name", async () => {
    vi.mocked(getTask).mockResolvedValue({ ...original, assigneeMemberId: undefined, subscriberMemberIds: undefined });
    const render = page(); render(); await settle();
    const tree = render();
    expect(picker(tree, "AssigneePicker").props).toMatchObject({ value: "", label: "old" });
    expect(picker(tree, "SubscribersPicker").props).toMatchObject({ value: ["user"], historicalNames: ["old"] });
    changeTitle(tree); await button(render(), "Save").props.onClick();
    const patch = vi.mocked(updateTask).mock.calls[0][2];
    expect(patch.title).toBe("Edited");
    expect(patch).not.toHaveProperty("assignee");
    expect(patch).not.toHaveProperty("subscribers");
    expect(patch).not.toHaveProperty("createdBy");
    expect(patch).not.toHaveProperty("comments");
  });

  it("sends only explicitly changed participant fields, preserving user and authoritative ID watchers", async () => {
    vi.mocked(getTask).mockResolvedValue({ ...original, assigneeMemberId: undefined, subscribers: ["old", "user"], subscriberMemberIds: ["mem_one"] });
    const render = page(); render(); await settle();
    let tree = render();
    button(openPicker(picker(tree, "SubscribersPicker")), "other").props.onClick();
    tree = render();
    expect(picker(tree, "SubscribersPicker").props.historicalNames).toEqual([]);
    await button(tree, "Save").props.onClick();
    expect(vi.mocked(updateTask).mock.calls[0][2]).toMatchObject({ subscribers: ["mem_one", "user", "mem_two"] });
    expect(vi.mocked(updateTask).mock.calls[0][2]).not.toHaveProperty("assignee");
    button(openPicker(picker(render(), "AssigneePicker")), "Unassigned").props.onClick();
    await button(render(), "Save").props.onClick();
    expect(vi.mocked(updateTask).mock.calls[1][2]).toMatchObject({ assignee: null });
    expect(vi.mocked(updateTask).mock.calls[1][2]).not.toHaveProperty("subscribers");
  });

  it("creates tasks with selected IDs, not current labels", async () => {
    const render = page(""); render(); await settle();
    const tree = render();
    changeTitle(tree);
    button(openPicker(picker(tree, "AssigneePicker")), "old").props.onClick();
    button(openPicker(picker(tree, "SubscribersPicker")), "other").props.onClick();
    await button(render(), "Create task").props.onClick();
    expect(vi.mocked(createTask).mock.calls[0][1]).toMatchObject({ assignee: "mem_one", subscribers: ["mem_two"], createdBy: "user" });
  });

  it("never infers IDs from labels and emits explicit clears only when dirty", () => {
    expect(taskParticipantSelection({ subscribers: ["mem_other", "user"], subscriberMemberIds: ["mem_one"] }).subscribers).toEqual(["mem_one", "user"]);
    expect(taskParticipantSelection({ subscribers: ["mem_other"], subscriberMemberIds: [] }).subscribers).toEqual([]);
    expect(taskParticipantSelection({ assignee: "mem_one", subscribers: ["user", "mem_one", "legacy", "mem_one"] })).toEqual({ assignee: "", subscribers: ["user"], legacyAssignee: "mem_one", legacySubscribers: ["mem_one", "legacy"] });
    expect(taskParticipantSelection({ assignee: "old", assigneeMemberId: "mem_one", subscribers: ["old", "user"], subscriberMemberIds: ["mem_one"] }).subscribers).toEqual(["mem_one", "user"]);
    expect(taskParticipantPatch("", [], false, false)).toEqual({});
    expect(taskParticipantPatch("", [], true, true)).toEqual({ assignee: null, subscribers: [] });
  });
});
