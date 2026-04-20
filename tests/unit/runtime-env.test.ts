import { describe, it, expect } from "vitest";
import { getCleanSpawnEnv } from "../../src/engine/runtime/env.js";

describe("getCleanSpawnEnv", () => {
  it("removes nested Claude vars and enforces SDK runtime vars", () => {
    const prev = {
      CLAUDECODE: process.env.CLAUDECODE,
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
      DISABLE_AUTOUPDATER: process.env.DISABLE_AUTOUPDATER,
    };

    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_ENTRYPOINT = "interactive";
    process.env.DISABLE_AUTOUPDATER = "0";

    try {
      const env = getCleanSpawnEnv();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
      expect(env.DISABLE_AUTOUPDATER).toBe("1");
    } finally {
      if (prev.CLAUDECODE === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev.CLAUDECODE;
      if (prev.CLAUDE_CODE_ENTRYPOINT === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = prev.CLAUDE_CODE_ENTRYPOINT;
      if (prev.DISABLE_AUTOUPDATER === undefined) delete process.env.DISABLE_AUTOUPDATER;
      else process.env.DISABLE_AUTOUPDATER = prev.DISABLE_AUTOUPDATER;
    }
  });
});
