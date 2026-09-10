import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MemberInfo } from "../../web/src/api/client";
import type { RoomContactSelection } from "../../web/src/components/CreateRoomDialog";
let reduce: typeof import("../../web/src/components/CreateRoomDialog").roomContactSelection;
beforeAll(async () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  ({ roomContactSelection: reduce } = await import("../../web/src/components/CreateRoomDialog"));
});
const contact = (id: string, name: string): MemberInfo => ({ id, name, agent: "legacy", thinkingLevel: "medium" });
const empty: RoomContactSelection = { members: [], leaderMemberId: "" };

describe("existing-contact selection replaces template name suggestions", () => {
  it("ignores a repeated ID rather than cloning or suffixing a contact", () => {
    const member = Object.freeze(contact("mem-a", "QA"));
    const state = reduce(empty, { type: "add", member });
    expect(reduce(state, { type: "add", member })).toBe(state);
    expect(state.members).toEqual([member]);
    expect(state.leaderMemberId).toBe("mem-a");
  });

  it("preserves same-name contacts and literal Unicode, whitespace, backticks and ID-shaped names", () => {
    const names = [" QA ", " QA ", "言 实 `研发`", "mem-a", "qa", "QA"];
    const state = names.reduce((state, name, i) => reduce(state, { type: "add", member: contact(`mem-${i}`, name) }), empty);
    expect(state.members.map((member) => member.name)).toEqual(names);
    expect(new Set(state.members.map((member) => member.id)).size).toBe(names.length);
  });

  it("accepts only a selected ID as leader, never an ID-shaped display name", () => {
    const state = reduce(empty, { type: "add", member: contact("mem-a", "mem-b") });
    expect(reduce(state, { type: "leader", memberId: "mem-b" })).toBe(state);
    const next = reduce(state, { type: "add", member: contact("mem-b", "Other") });
    expect(reduce(next, { type: "leader", memberId: "mem-b" }).leaderMemberId).toBe("mem-b");
  });

  it("removing a nonleader keeps the leader; removing the leader selects the first remaining or clears it", () => {
    let state = ["a", "b", "c"].reduce((state, id) => reduce(state, { type: "add", member: contact(id, "Same name") }), empty);
    state = reduce(state, { type: "leader", memberId: "b" });
    state = reduce(state, { type: "remove", memberId: "c" });
    expect(state.leaderMemberId).toBe("b");
    state = reduce(state, { type: "remove", memberId: "b" });
    expect(state.leaderMemberId).toBe("a");
    expect(reduce(state, { type: "remove", memberId: "a" })).toEqual(empty);
  });
});
