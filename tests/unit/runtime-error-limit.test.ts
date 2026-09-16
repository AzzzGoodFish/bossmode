import { describe, expect, it } from "vitest";
import {
  USER_VISIBLE_RUNTIME_ERROR_MAX_LENGTH,
  limitRuntimeErrorEvent,
  limitRuntimeErrorMessage,
  limitRuntimeFailureRoomMessage,
} from "../../src/kernel/runtime-error-limit.js";

describe("user-visible runtime error limit", () => {
  it("keeps a 300-character error unchanged", () => {
    const message = "x".repeat(300);
    expect(limitRuntimeErrorMessage(message)).toBe(message);
  });

  it("caps a 301-character error at 300 characters with an ellipsis", () => {
    const result = limitRuntimeErrorMessage("x".repeat(301));
    expect(Array.from(result)).toHaveLength(USER_VISIBLE_RUNTIME_ERROR_MAX_LENGTH);
    expect(result).toBe(`${"x".repeat(299)}…`);
  });

  it("caps a 5,763-character HTML provider error", () => {
    const result = limitRuntimeErrorMessage(`<html>${"x".repeat(5_750)}</html>`);
    expect(Array.from(result)).toHaveLength(300);
    expect(result.endsWith("…")).toBe(true);
  });

  it("caps runtime event errors without changing normal member output", () => {
    const error = limitRuntimeErrorEvent({ type: "message_end", text: "", errorMessage: "e".repeat(5_763) });
    const compaction = limitRuntimeErrorEvent({
      type: "compaction_end",
      errorMessage: "e".repeat(5_763),
      result: { error: "e".repeat(5_763) },
    });
    const reply = limitRuntimeErrorEvent({ type: "message_end", text: "r".repeat(5_763) });

    expect(Array.from(error.errorMessage)).toHaveLength(300);
    expect(error.errorMessage.endsWith("…")).toBe(true);
    expect(Array.from(compaction.errorMessage)).toHaveLength(300);
    expect(Array.from(compaction.result.error)).toHaveLength(300);
    expect(reply.text).toHaveLength(5_763);
  });

  it("caps runtime failure room messages without changing user or member messages", () => {
    const failure = limitRuntimeFailureRoomMessage({ sender: "system", content: `Member "pm" request failed. Error: ${"e".repeat(5_763)}` });
    const user = limitRuntimeFailureRoomMessage({ sender: "user", content: "u".repeat(5_763) });
    const member = limitRuntimeFailureRoomMessage({ sender: "pm", content: "r".repeat(5_763) });

    expect(Array.from(failure.content)).toHaveLength(300);
    expect(failure.content.endsWith("…")).toBe(true);
    expect(user.content).toHaveLength(5_763);
    expect(member.content).toHaveLength(5_763);
  });
});
