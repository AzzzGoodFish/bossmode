import { describe, it, expect } from "vitest";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  CREATE_TASK_DESCRIPTION,
  UPDATE_TASK_DESCRIPTION,
  LIST_TASKS_DESCRIPTION,
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
      WRITE_SUMMARY_DESCRIPTION,
    ]) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(50);
    }
  });

  it("task tool descriptions contain usage guidance", () => {
    expect(CREATE_TASK_DESCRIPTION).toContain("Use this tool when");
    expect(CREATE_TASK_DESCRIPTION).toContain("Side effect");
    expect(UPDATE_TASK_DESCRIPTION).toContain("Use this tool when");
    expect(UPDATE_TASK_DESCRIPTION).toContain("Side effect");
    expect(LIST_TASKS_DESCRIPTION).toContain("Use this tool when");
  });

  it("create_task describes auto-activation", () => {
    expect(CREATE_TASK_DESCRIPTION).toContain("automatically activated");
  });

  it("update_task describes reassignment activation", () => {
    expect(UPDATE_TASK_DESCRIPTION).toContain("Reassigning");
  });

  it("all param descriptions are non-empty", () => {
    for (const [key, value] of Object.entries(PARAM_DESCRIPTIONS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(5);
    }
  });
});
