import { describe, expect, it } from "vitest";
import {
  ensureKimiAllowEmptySignature,
  isBase64Url,
  isInvalidThinkingSignature,
  sanitizeThinkingSignaturesInMessages,
} from "../../src/engine/runtime/thinking-signature.js";

/** Real-shape standard base64 signature (contains + /) from a live session. */
const STD_B64 =
  "1vwzsX70gRpP6tjZuCNpklb5X3btSJV9+HXerpnPW40lSi6XSejgtDIuj95j+8nbUpOSK1NSKVDsFd0R6GIv0UIg/v5OaSo+J6VDpc+vyMaTeh0Q";

/** Same payload re-encoded as base64url. */
const B64URL = STD_B64.replace(/\+/g, "-").replace(/\//g, "_");

describe("thinking signature base64url gate", () => {
  it("accepts empty and pure base64url", () => {
    expect(isBase64Url("")).toBe(false);
    expect(isBase64Url(B64URL)).toBe(true);
    expect(isInvalidThinkingSignature("")).toBe(false);
    expect(isInvalidThinkingSignature(undefined)).toBe(false);
    expect(isInvalidThinkingSignature(B64URL)).toBe(false);
  });

  it("rejects standard base64 with + and /", () => {
    expect(isBase64Url(STD_B64)).toBe(false);
    expect(isInvalidThinkingSignature(STD_B64)).toBe(true);
  });
});

describe("sanitizeThinkingSignaturesInMessages", () => {
  it("clears invalid signatures on assistant thinking blocks, keeps valid and non-thinking", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan", thinkingSignature: STD_B64 },
          { type: "thinking", thinking: "ok", thinkingSignature: B64URL },
          { type: "text", text: "done" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "empty sig", thinkingSignature: "" }],
      },
    ];
    const cleared = sanitizeThinkingSignaturesInMessages(messages);
    expect(cleared).toBe(1);
    const blocks = messages[1].content as Array<{ thinkingSignature?: string }>;
    expect(blocks[0].thinkingSignature).toBe("");
    expect(blocks[1].thinkingSignature).toBe(B64URL);
    expect((messages[2].content as any)[0].thinkingSignature).toBe("");
  });

  it("is a no-op on non-arrays and non-assistant roles", () => {
    expect(sanitizeThinkingSignaturesInMessages(null)).toBe(0);
    expect(sanitizeThinkingSignaturesInMessages([{ role: "user", content: [{ type: "thinking", thinkingSignature: STD_B64 }] }])).toBe(0);
  });
});

describe("ensureKimiAllowEmptySignature", () => {
  it("sets allowEmptySignature on kimi-coding models that lack it (k3-256k shape)", () => {
    const model = { provider: "kimi-coding", id: "k3-256k", compat: { forceAdaptiveThinking: true } };
    ensureKimiAllowEmptySignature(model);
    expect(model.compat).toEqual({ forceAdaptiveThinking: true, allowEmptySignature: true });
  });

  it("does not touch non-kimi providers", () => {
    const model = { provider: "anthropic", compat: { forceAdaptiveThinking: true } };
    ensureKimiAllowEmptySignature(model);
    expect(model.compat).toEqual({ forceAdaptiveThinking: true });
  });

  it("is idempotent when already true", () => {
    const model = { provider: "kimi-coding", compat: { allowEmptySignature: true } };
    ensureKimiAllowEmptySignature(model);
    expect(model.compat.allowEmptySignature).toBe(true);
  });
});
