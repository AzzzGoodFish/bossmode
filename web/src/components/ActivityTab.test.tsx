import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { AgentEvent } from "./agent-event-utils";

type Effect = () => void | (() => void);
type Slot = { value?: any; deps?: readonly unknown[]; cleanup?: void | (() => void) };
type Frame = { cursor: number; slots: Slot[]; effects: (() => void)[]; dirty: boolean };

const runtime = vi.hoisted(() => ({ frame: null as Frame | null }));
vi.mock("react", async (original) => {
  function slot() {
    const frame = runtime.frame!;
    const index = frame.cursor++;
    return frame.slots[index] ??= {};
  }
  function changed(previous?: readonly unknown[], next?: readonly unknown[]) {
    return !previous || !next || previous.length !== next.length
      || next.some((value, index) => !Object.is(value, previous[index]));
  }
  function memo(compute: () => unknown, deps?: readonly unknown[]) {
    const current = slot();
    if (changed(current.deps, deps)) {
      current.value = compute();
      current.deps = deps;
    }
    return current.value;
  }
  return {
    ...await original<typeof import("react")>(),
    useState(initial: any) {
      const frame = runtime.frame!;
      const current = slot();
      if (!("value" in current)) {
        let value = typeof initial === "function" ? initial() : initial;
        const set = (update: any) => {
          const next = typeof update === "function" ? update(value) : update;
          if (!Object.is(value, next)) {
            value = next;
            current.value = [value, set];
            frame.dirty = true;
          }
        };
        current.value = [value, set];
      }
      return current.value;
    },
    useRef(initial: unknown) {
      const current = slot();
      if (!("value" in current)) current.value = { current: initial };
      return current.value;
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect(effect: Effect, deps?: readonly unknown[]) {
      const current = slot();
      if (changed(current.deps, deps)) {
        current.deps = deps;
        runtime.frame!.effects.push(() => {
          current.cleanup?.();
          current.cleanup = effect();
        });
      }
    },
  };
});
vi.mock("./Markdown", () => ({ Markdown: () => null }));
vi.mock("../api/client", () => ({
  getMemberActivityEvents: vi.fn(),
  getMemberScopedActivityEvents: vi.fn(),
  getToken: vi.fn(() => "test-token"),
}));

import { getMemberActivityEvents, getMemberScopedActivityEvents } from "../api/client";
import { ActivityTab } from "./ActivityTab";

type Element = ReactElement<any>;
type Props = Parameters<typeof ActivityTab>[0];
type Page = Awaited<ReturnType<typeof getMemberActivityEvents>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function nodes(tree: any): Element[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !tree.props) return [];
  return [tree, ...nodes(tree.props.children)];
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return typeof tree === "string" ? tree : tree?.props ? text(tree.props.children) : "";
}
function olderButton(tree: Element) {
  return nodes(tree).find((node) => node.type === "button" && /Load earlier activity|^Loading…$/.test(text(node)));
}
// Inspect the actual parent's child props, not a reimplementation of its history logic.
// Child components are deliberately not executed: this is a shallow hook renderer.
function visibleEvents(tree: Element): AgentEvent[] {
  return nodes(tree).flatMap((node) => node.props.events ?? []);
}

class Socket {
  static instances: Socket[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  close = vi.fn();
  constructor(readonly url: string) { Socket.instances.push(this); }
  event(roomId: string, memberId: string, agent: string, event: AgentEvent) {
    this.onmessage?.({ data: JSON.stringify({ type: "agent:event", roomId, memberId, agent, event }) });
  }
}

const mounted: (() => void)[] = [];
function harness(initial: Props) {
  let props = initial;
  const frame: Frame = { cursor: 0, slots: [], effects: [], dirty: false };
  const listeners = new Set<() => void>();
  const scroll = {
    scrollTop: 0, scrollHeight: 1000,
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  function render(next = props): Element {
    props = next;
    let tree!: Element;
    let renders = 0;
    do {
      if (++renders > 25) throw new Error("ActivityTab did not settle (unstable hook dependency?)");
      frame.dirty = false;
      frame.cursor = 0;
      runtime.frame = frame;
      try { tree = ActivityTab(props); } finally { runtime.frame = null; }
      // Commit the one host ref before effects, as React does. No document/DOM needed.
      for (const node of nodes(tree)) if (node.props.ref) node.props.ref.current = scroll;
      frame.effects.splice(0).forEach((effect) => effect());
    } while (frame.dirty);
    return tree;
  }
  async function settle() {
    await Promise.resolve();
    await Promise.resolve();
    return render();
  }
  function unmount() {
    frame.slots.forEach((slot) => { slot.cleanup?.(); slot.cleanup = undefined; });
  }
  mounted.push(unmount);
  return { render, settle, scroll, unmount, scrollUp: () => {
    scroll.scrollTop = 20;
    [...listeners].forEach((listener) => listener());
  } };
}

const scopes = [
  { name: "room", scopeId: "room_one" },
  { name: "DM", scopeId: "dm:mem_one" },
] as const;
function propsFor(name: typeof scopes[number]["name"], agentName = "old", memberId = "mem_one", scopeId?: string): Props {
  return {
    roomId: "room_one", agentName, memberId,
    ...(name === "DM" ? { dmScope: { scopeId: scopeId ?? `dm:${memberId}`, memberId } } : {}),
  };
}
function reply(text: string): AgentEvent { return { type: "message_end", text, ts: 1000 }; }

beforeEach(() => {
  vi.resetAllMocks();
  Socket.instances = [];
  vi.stubGlobal("window", { location: { protocol: "https:", host: "activity.test" } });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { callback(); return 1; });
});
afterEach(() => {
  mounted.splice(0).forEach((unmount) => unmount());
  vi.unstubAllGlobals();
});

describe.each(scopes)("ActivityTab stable $name identity", ({ name, scopeId }) => {
  it("retains loaded/live history, pagination and its socket across rename rerenders", async () => {
    const initial = deferred<Page>();
    const older = deferred<Page>();
    const last = deferred<Page>();
    const api = vi.mocked(name === "room" ? getMemberActivityEvents : getMemberScopedActivityEvents);
    api.mockReturnValueOnce(initial.promise).mockReturnValueOnce(older.promise).mockReturnValueOnce(last.promise);
    const args = name === "room" ? ["room_one", "mem_one", 120] : ["mem_one", scopeId, 120];
    const view = harness(propsFor(name));
    expect(text(view.render())).toContain("Loading activity…");
    expect(api.mock.calls).toEqual([args]);
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0];
    socket.onopen!();
    expect(socket.url).toBe("wss://activity.test/ws?token=test-token");
    expect(JSON.parse(socket.send.mock.calls[0][0])).toEqual({
      type: "subscribe:agent", roomId: scopeId, agent: "mem_one", memberId: "mem_one",
    });

    const recent = reply("recent history");
    const earlier = reply("earlier history");
    const live = reply("live after rename");
    initial.resolve({ events: [recent], hasMore: true, nextBeforeSeq: 100 });
    let tree = await view.settle();
    expect(visibleEvents(tree)).toEqual([recent]);
    expect(view.scroll.scrollTop).toBe(1000);
    olderButton(tree)!.props.onClick();
    expect(api.mock.calls).toEqual([args, [...args, 100]]);
    older.resolve({ events: [earlier], hasMore: true, nextBeforeSeq: 50 });
    tree = await view.settle();
    expect(visibleEvents(tree)).toEqual([earlier, recent]);

    view.scroll.scrollTop = 200;
    // Each call creates a fresh dmScope/activityScope object with unchanged IDs.
    tree = view.render(propsFor(name, "renamed"));
    socket.event(scopeId, "mem_other", "old", reply("wrong member"));
    socket.event("wrong_scope", "mem_one", "renamed", reply("wrong scope"));
    socket.event(scopeId, "mem_one", "renamed", live);
    tree = await view.settle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(Socket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(text(tree)).not.toContain("Loading activity…");
    expect(visibleEvents(tree)).toEqual([earlier, recent, live]);
    expect(view.scroll.scrollTop).toBe(200);
    expect(olderButton(tree)!.props.disabled).toBe(false);

    // The retained cursor is 50, not the initial 100. The ref must also survive
    // rerenders and block duplicate scroll requests while this page is pending.
    view.scrollUp();
    tree = view.render(propsFor(name, "renamed_again"));
    expect(olderButton(tree)!.props.disabled).toBe(true);
    expect(visibleEvents(tree)).toEqual([earlier, recent, live]);
    view.scrollUp();
    expect(api.mock.calls).toEqual([args, [...args, 100], [...args, 50]]);
    const oldest = reply("oldest history");
    last.resolve({ events: [oldest], hasMore: false, nextBeforeSeq: null });
    await view.settle();
    tree = view.render(propsFor(name, "final_name"));
    expect(visibleEvents(tree)).toEqual([oldest, earlier, recent, live]);
    expect(olderButton(tree)).toBeUndefined();
    view.scrollUp();
    expect(api).toHaveBeenCalledTimes(3);
    expect(Socket.instances).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    const unusedApi = name === "room" ? getMemberScopedActivityEvents : getMemberActivityEvents;
    expect(unusedApi).not.toHaveBeenCalled();
    view.unmount();
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(view.scroll.removeEventListener).toHaveBeenCalled();
  });

  it("does reload and replace the socket when the stable identity changes", async () => {
    const api = vi.mocked(name === "room" ? getMemberActivityEvents : getMemberScopedActivityEvents);
    api.mockResolvedValue({ events: [reply("history")], hasMore: false, nextBeforeSeq: null });
    const view = harness(propsFor(name));
    view.render();
    await view.settle();
    const first = Socket.instances[0];
    const nextScope = name === "room" ? "room_one" : "dm:mem_two";
    const nextMember = "mem_two";
    view.render(propsFor(name, "old", nextMember, nextScope));
    await view.settle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenLastCalledWith(...(name === "room"
      ? ["room_one", nextMember, 120] : [nextMember, nextScope, 120]));
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].onopen!();
    expect(JSON.parse(Socket.instances[1].send.mock.calls[0][0])).toEqual({
      type: "subscribe:agent", roomId: nextScope, agent: nextMember, memberId: nextMember,
    });
  });
});
