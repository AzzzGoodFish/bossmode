import { describe, it, expect } from "vitest";
import {
  QUERY_ROOM_MESSAGES_DESCRIPTION,
  LIST_SCOPES_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../src/shared/mcp-tool-descriptions.js";

describe("mcp-tool-descriptions", () => {
  it("all descriptions are non-empty strings", () => {
    for (const desc of [
      QUERY_ROOM_MESSAGES_DESCRIPTION,
      LIST_SCOPES_DESCRIPTION,
    ]) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(50);
    }
  });

  it("has no leftover write_summary / summarizer residue", async () => {
    const mod = await import("../../src/shared/mcp-tool-descriptions.js");
    expect((mod as any).WRITE_SUMMARY_DESCRIPTION).toBeUndefined();
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summaryTitle");
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summaryFromId");
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summaryToId");
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summary");
  });

  it("has no leftover task tool descriptions or parameters (task feature retired)", async () => {
    const mod = await import("../../src/shared/mcp-tool-descriptions.js");
    for (const key of ["CREATE_TASK_DESCRIPTION", "UPDATE_TASK_DESCRIPTION", "LIST_TASKS_DESCRIPTION", "GET_TASK_DESCRIPTION", "COMMENT_TASK_DESCRIPTION"]) {
      expect((mod as any)[key]).toBeUndefined();
    }
    for (const key of ["taskTitle", "taskId", "taskStatus", "taskPriority", "taskAssignee", "taskComment", "taskReferences", "taskSubscribers"]) {
      expect(PARAM_DESCRIPTIONS).not.toHaveProperty(key);
    }
  });

  it("has no references to retired memory tools", () => {
    for (const desc of [QUERY_ROOM_MESSAGES_DESCRIPTION, LIST_SCOPES_DESCRIPTION]) {
      expect(desc).not.toMatch(/read_memory|write_memory|edit_memory/);
    }
  });

  it("all param descriptions are non-empty", () => {
    for (const [key, value] of Object.entries(PARAM_DESCRIPTIONS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(5);
    }
  });
});
