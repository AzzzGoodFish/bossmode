import { describe, it, expect } from "vitest";
import {
  CHAT_READ_DESCRIPTION,
  CHAT_SEARCH_DESCRIPTION,
  CHAT_LIST_DESCRIPTION,
  BOSSMODE_GATEWAY_DESCRIPTION,
  CHAT_INFO_DESCRIPTION,
  CHAT_CREATE_DESCRIPTION,
  CHAT_EDIT_DESCRIPTION,
  MEMBER_LIST_DESCRIPTION,
  MEMBER_INFO_DESCRIPTION,
  PROFILE_READ_DESCRIPTION,
  PROFILE_UPDATE_DESCRIPTION,
  PARAM_DESCRIPTIONS,
} from "../../src/agent/tools.js";
import { buildChatSendToolDescription } from "../../src/agent/tools.js";

describe("tool catalog", () => {
  it("all batch-3 tool descriptions are non-empty strings", () => {
    for (const desc of [
      buildChatSendToolDescription(),
      CHAT_READ_DESCRIPTION,
      CHAT_SEARCH_DESCRIPTION,
      CHAT_LIST_DESCRIPTION,
      BOSSMODE_GATEWAY_DESCRIPTION,
      CHAT_INFO_DESCRIPTION,
      CHAT_CREATE_DESCRIPTION,
      CHAT_EDIT_DESCRIPTION,
      MEMBER_LIST_DESCRIPTION,
      MEMBER_INFO_DESCRIPTION,
      PROFILE_READ_DESCRIPTION,
      PROFILE_UPDATE_DESCRIPTION,
    ]) {
      expect(typeof desc).toBe("string");
      expect(desc.length).toBeGreaterThan(50);
    }
  });

  it("retired tool descriptions are gone (batch 3 renames)", async () => {
    const mod = await import("../../src/agent/tools.js");
    for (const key of ["QUERY_ROOM_MESSAGES_DESCRIPTION", "LIST_SCOPES_DESCRIPTION", "WAIT_DESCRIPTION"]) {
      expect((mod as any)[key]).toBeUndefined();
    }
    for (const key of ["scope", "type"]) {
      expect(PARAM_DESCRIPTIONS).not.toHaveProperty(key);
    }
  });

  it("has no leftover write_summary / summarizer residue", async () => {
    const mod = await import("../../src/agent/tools.js");
    expect((mod as any).WRITE_SUMMARY_DESCRIPTION).toBeUndefined();
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summaryTitle");
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summaryFromId");
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summaryToId");
    expect(PARAM_DESCRIPTIONS).not.toHaveProperty("summary");
  });

  it("has no leftover task tool descriptions or parameters (task feature retired)", async () => {
    const mod = await import("../../src/agent/tools.js");
    for (const key of ["CREATE_TASK_DESCRIPTION", "UPDATE_TASK_DESCRIPTION", "LIST_TASKS_DESCRIPTION", "GET_TASK_DESCRIPTION", "COMMENT_TASK_DESCRIPTION"]) {
      expect((mod as any)[key]).toBeUndefined();
    }
    for (const key of ["taskTitle", "taskId", "taskStatus", "taskPriority", "taskAssignee", "taskComment", "taskReferences", "taskSubscribers"]) {
      expect(PARAM_DESCRIPTIONS).not.toHaveProperty(key);
    }
  });

  it("has no references to retired memory tools", () => {
    for (const desc of [CHAT_READ_DESCRIPTION, CHAT_SEARCH_DESCRIPTION, CHAT_LIST_DESCRIPTION, buildChatSendToolDescription()]) {
      expect(desc).not.toMatch(/read_memory|write_memory|edit_memory/);
    }
  });

  it("all param descriptions are non-empty", () => {
    for (const [key, value] of Object.entries(PARAM_DESCRIPTIONS)) {
      expect(typeof value, key).toBe("string");
      expect(value.length).toBeGreaterThan(5);
    }
  });
});
