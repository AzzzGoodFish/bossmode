import { describe, expect, it, vi } from "vitest";
import {
  currentMemberName, getMemberProfileRevision, publishMemberProfileChanged, subscribeMemberProfiles,
} from "./useMemberProfileRevision";

describe("current member profile invalidation", () => {
  it("invalidates current readers globally and by member ID, including title clearing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMemberProfiles(listener);
    const before = getMemberProfileRevision();
    const other = getMemberProfileRevision("unrelated");
    publishMemberProfileChanged({ type: "member:profile", memberId: "one", name: "renamed", title: "Engineer" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getMemberProfileRevision()).toBe(before + 1);
    expect(getMemberProfileRevision("one")).toBe(before + 1);
    expect(getMemberProfileRevision("unrelated")).toBe(other);
    publishMemberProfileChanged({ type: "member:profile", memberId: "one", name: "renamed", title: null });
    expect(getMemberProfileRevision("one")).toBe(before + 2);
    unsubscribe();
    publishMemberProfileChanged({ type: "member:profile", memberId: "one", name: "renamed", title: null });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("routes live labels only by stable ID and does not rewrite sender/mention snapshots", () => {
    const historical = Object.freeze({ sender: "old", senderMemberId: "two", mentions: Object.freeze(["old"]), content: "@old hello" });
    publishMemberProfileChanged({ type: "member:profile", memberId: "two", name: "new", title: null });
    expect(currentMemberName("two", historical.sender)).toBe("new");
    expect(currentMemberName(undefined, "old")).toBe("old");
    expect(currentMemberName("different", "old")).toBe("old");
    expect(historical).toEqual({ sender: "old", senderMemberId: "two", mentions: ["old"], content: "@old hello" });
    publishMemberProfileChanged({ type: "member:profile", memberId: "two", name: "newer", title: null });
    expect(currentMemberName("two", "old")).toBe("newer");
  });
});
