import { describe, expect, it } from "vitest";
import { resolvePiSystemPromptSources } from "../../src/engine/runtime/pi-sdk.js";

describe("resolvePiSystemPromptSources", () => {
  const role = "ROLE_PROMPT_BODY";
  const appends = ["env block", "principles"];

  it("off (default): role replaces systemPrompt, appends unchanged", () => {
    const r = resolvePiSystemPromptSources({
      agentPrompt: role,
      appendSystemPrompt: appends,
      agentTemplate: "developer",
      piBuiltinPrompt: false,
    });
    expect(r.systemPrompt).toBe(role);
    expect(r.appendSystemPrompt).toEqual(appends);
  });

  it("on + non-general: systemPrompt undefined, role heads append", () => {
    const r = resolvePiSystemPromptSources({
      agentPrompt: role,
      appendSystemPrompt: appends,
      agentTemplate: "developer",
      piBuiltinPrompt: true,
    });
    expect(r.systemPrompt).toBeUndefined();
    expect(r.appendSystemPrompt[0]).toBe(role);
    expect(r.appendSystemPrompt.slice(1)).toEqual(appends);
  });

  it("on + general: same as off (replace mode pinned)", () => {
    const r = resolvePiSystemPromptSources({
      agentPrompt: role,
      appendSystemPrompt: appends,
      agentTemplate: "general",
      piBuiltinPrompt: true,
    });
    expect(r.systemPrompt).toBe(role);
    expect(r.appendSystemPrompt).toEqual(appends);
  });
});
