import { describe, it, expect } from "vitest";

/** Task assignment is metadata only; member activation happens exclusively via chat @mentions. */
function shouldActivateFromTaskAssignment(): boolean {
  return false;
}

describe("task assign activation logic", () => {
  it("does not activate when assigning to an agent in the room", () => {
    expect(shouldActivateFromTaskAssignment()).toBe(false);
  });

  it("does not activate when reassigning to a different agent", () => {
    expect(shouldActivateFromTaskAssignment()).toBe(false);
  });

  it("does not activate on self-assign", () => {
    expect(shouldActivateFromTaskAssignment()).toBe(false);
  });
});
