import { describe, expect, it } from "vitest";
import { buildResponseToolDescription, RESPONSE_MESSAGE_PARAM_DESCRIPTION } from "../../src/shared/response-tool-description.js";

describe("chat tool description", () => {
  it("makes @mention activation semantics explicit and lists room members", () => {
    const text = buildResponseToolDescription("pm, qa");
    expect(text).toContain("@name activates that member and asks for a reply");
    expect(text).toContain("a plain name never activates");
    expect(text).toContain("pm, qa");
    expect(RESPONSE_MESSAGE_PARAM_DESCRIPTION).toContain("requests a reply");
  });

  it("describes only capability and mechanical facts — no target/private-message/envelope-footer usage guidance", () => {
    const text = buildResponseToolDescription("pm, qa");
    expect(text).not.toContain("target");
    expect(text).not.toContain("envelope footer");
    expect(text).not.toContain("private");
  });
});
