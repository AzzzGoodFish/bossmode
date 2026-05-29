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

  it("task tool descriptions contain usage guidance", () => {
    expect(CREATE_TASK_DESCRIPTION).toContain("Use this tool when");
    expect(CREATE_TASK_DESCRIPTION).toContain("Assignment and subscribers record ownership/watchers only");
    expect(UPDATE_TASK_DESCRIPTION).toContain("Use this tool when");
    expect(UPDATE_TASK_DESCRIPTION).toContain("Assignment and subscribers record ownership/watchers only");
    expect(LIST_TASKS_DESCRIPTION).toContain("Use this tool when");
    expect(GET_TASK_DESCRIPTION).toContain("full details");
    expect(COMMENT_TASK_DESCRIPTION).toContain("Add a comment");
  });

  it("task tool descriptions do not claim assignment, subscribers, or comments activate members", () => {
    const combined = `${CREATE_TASK_DESCRIPTION}\n${UPDATE_TASK_DESCRIPTION}\n${LIST_TASKS_DESCRIPTION}\n${GET_TASK_DESCRIPTION}\n${COMMENT_TASK_DESCRIPTION}`;
    expect(combined).not.toMatch(/automatically activates?|automatically activated/i);
    expect(combined).not.toContain("Reassigning to a different agent");
    expect(combined).toContain("send a room chat message with exact @name");
    expect(combined).toContain("subscribers");
    expect(combined).toMatch(/never activate members/i);
    expect(COMMENT_TASK_DESCRIPTION).toContain("do not activate members");
  });

  it("all param descriptions are non-empty", () => {
    for (const [key, value] of Object.entries(PARAM_DESCRIPTIONS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(5);
    }
  });
});
