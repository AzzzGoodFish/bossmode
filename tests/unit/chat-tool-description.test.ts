import { describe, expect, it } from "vitest";
import { buildChatToolDescription, CHAT_MESSAGE_PARAM_DESCRIPTION } from "../../src/shared/chat-tool-description.js";

describe("chat tool description", () => {
  it("makes @mention reply semantics explicit", () => {
    const text = buildChatToolDescription("pm, qa");
    expect(text).toContain("@name activates that member and asks them to reply");
    expect(text).toContain("write their name without @");
    expect(CHAT_MESSAGE_PARAM_DESCRIPTION).toContain("requests a reply");
  });
});
