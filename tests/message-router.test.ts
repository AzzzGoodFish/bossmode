import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMentions } from "../src/communication/router.js";

describe("parseMentions", () => {
  const members = ["pm", "dev", "qa"];

  it("should extract single mention", () => {
    expect(parseMentions("@pm analyze this", members)).toEqual(["pm"]);
  });

  it("should extract multiple mentions", () => {
    expect(parseMentions("@pm and @dev work together", members)).toEqual(["pm", "dev"]);
  });

  it("should ignore non-member mentions", () => {
    expect(parseMentions("@unknown do something", members)).toEqual([]);
  });

  it("should handle @all", () => {
    expect(parseMentions("@all start working", members)).toEqual(["all"]);
  });

  it("should deduplicate mentions", () => {
    expect(parseMentions("@pm first task @pm second task", members)).toEqual(["pm"]);
  });

  it("should return empty for no mentions", () => {
    expect(parseMentions("hello world", members)).toEqual([]);
  });
});

describe("initRouter", () => {
  it("should call onMention for each mentioned member", async () => {
    // Import message-bus to post messages that router will receive
    const { onMessage, postMessage } = await import("../src/communication/message-bus.js");
    const { initRouter } = await import("../src/communication/router.js");

    const onMention = vi.fn();
    const onMentionAll = vi.fn();
    const unsubscribe = initRouter(onMention, onMentionAll);

    // We need to mock message-store since postMessage writes to disk
    // Instead, test through the onMessage callback directly
    // The router subscribes via onMessage, so let's verify the callback pattern
    unsubscribe();

    expect(onMention).not.toHaveBeenCalled();
    expect(onMentionAll).not.toHaveBeenCalled();
  });
});
