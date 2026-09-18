import { describe, it, expect } from "vitest";
import { getPiSpawnEnv } from "../../src/agent/runtime/pi.js";

describe("getPiSpawnEnv", () => {
  it("inherits process env without Claude-specific mutation", () => {
    const prev = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_ENTRYPOINT = "interactive";
    try {
      const env = getPiSpawnEnv();
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("interactive");
      expect(env.PI_CODING_AGENT_DIR).toBe(process.env.PI_CODING_AGENT_DIR);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = prev;
    }
  });

  it("injects PI_CODING_AGENT_DIR when provided", () => {
    expect(getPiSpawnEnv("/tmp/pi-agent").PI_CODING_AGENT_DIR).toBe("/tmp/pi-agent");
  });
});
