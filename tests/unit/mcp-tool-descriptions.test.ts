import { describe, it, expect } from "vitest";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
  GET_TASK_DESCRIPTION,
  COMMENT_TASK_DESCRIPTION,
  WRITE_SUMMARY_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../src/shared/mcp-tool-descriptions.js";

describe("mcp-tool-descriptions", () => {
  it("all descriptions are non-empty strings", () => {
    for (const desc of [
      QUERY_ROOM_MESSAGES_DESCRIPTION,
      CREATE_TASK_DESCRIPTION,
      UPDATE_TASK_DESCRIPTION,
      LIST_TASKS_DESCRIPTION,
      GET_TASK_DESCRIPTION,
      COMMENT_TASK_DESCRIPTION,
      WRITE_SUMMARY_DESCRIPTION,
    ]) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(50);
    }
  });

  it("task tool descriptions state capability and mechanical facts, not usage guidance", () => {
    expect(CREATE_TASK_DESCRIPTION).toContain("Create a task");
    expect(CREATE_TASK_DESCRIPTION).toContain("never activate members");
    expect(UPDATE_TASK_DESCRIPTION).toContain("Status changes are posted as room system messages");
    expect(UPDATE_TASK_DESCRIPTION).toContain("never activate members");
    expect(LIST_TASKS_DESCRIPTION).toContain("commentCount");
    expect(GET_TASK_DESCRIPTION).toContain("comments");
    expect(COMMENT_TASK_DESCRIPTION).toContain("markdown comment");
  });

  it("task tool descriptions declare comment visibility as a mechanical fact and carry no usage-guidance phrasing", () => {
    const combined = `${CREATE_TASK_DESCRIPTION}\n${UPDATE_TASK_DESCRIPTION}\n${LIST_TASKS_DESCRIPTION}\n${GET_TASK_DESCRIPTION}\n${COMMENT_TASK_DESCRIPTION}`;
    expect(combined).not.toMatch(/automatically activates?|automatically activated/i);
    expect(combined).not.toMatch(/use this tool when/i);
    expect(combined).not.toContain("Reassigning to a different agent");
    expect(combined).toMatch(/never activate members/i);
    expect(COMMENT_TASK_DESCRIPTION).toContain("does not appear in the room stream");
    expect(COMMENT_TASK_DESCRIPTION).toContain("commented on task");
  });

  it("all param descriptions are non-empty", () => {
    for (const [key, value] of Object.entries(PARAM_DESCRIPTIONS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(5);
    }
  });
});
