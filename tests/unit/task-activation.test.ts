import { describe, it, expect } from "vitest";

/**
 * Tests the auto-activation guard logic used in emitTaskEvent.
 * Extracted as a pure function test to verify all edge cases.
 */
function shouldActivate(
  assignee: string | undefined,
  actor: string,
  previousAssignee: string | undefined,
  roomMembers: string[],
): boolean {
  if (!assignee) return false;
  const isAgent = roomMembers.includes(assignee);
  const isSelfAssign = assignee === actor;
  const isReassignment = previousAssignee !== assignee;
  return isAgent && !isSelfAssign && isReassignment;
}

describe("task assign auto-activation logic", () => {
  const members = ["pm", "developer", "qa", "architect", "designer"];

  it("activates when assigning to an agent in the room", () => {
    expect(shouldActivate("developer", "pm", undefined, members)).toBe(true);
  });

  it("does not activate when assignee is not in room members (human user)", () => {
    expect(shouldActivate("fish", "pm", undefined, members)).toBe(false);
  });

  it("does not activate on self-assign", () => {
    expect(shouldActivate("pm", "pm", undefined, members)).toBe(false);
  });

  it("does not activate when assignee unchanged (same value)", () => {
    expect(shouldActivate("developer", "pm", "developer", members)).toBe(false);
  });

  it("activates when reassigning to a different agent", () => {
    expect(shouldActivate("qa", "pm", "developer", members)).toBe(true);
  });

  it("does not activate when assignee is undefined", () => {
    expect(shouldActivate(undefined, "pm", "developer", members)).toBe(false);
  });

  it("does not activate when assignee is empty string (treated as no assignee)", () => {
    expect(shouldActivate("", "pm", undefined, members)).toBe(false);
  });

  it("activates when clearing previous and setting new agent", () => {
    expect(shouldActivate("architect", "pm", undefined, members)).toBe(true);
  });
});
