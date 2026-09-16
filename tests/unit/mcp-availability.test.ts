import { describe, expect, it } from "vitest";
import { checkMcpServerAvailability } from "../../src/agent/tools/mcp-availability.js";
import { sanitizeMcpError } from "../../src/shared/mcp-settings.js";

describe("MCP availability", () => {
  it("marks configs without url or command as invalid", async () => {
    const result = await checkMcpServerAvailability("bad", { headers: { Authorization: "Bearer secret" } }, 1000);
    expect(result.status).toBe("invalid-config");
    expect(result.error).not.toContain("secret");
  });

  it("sanitizes bearer/header/env secrets from errors", () => {
    const message = sanitizeMcpError(new Error("failed Bearer token-secret Authorization: top-secret env-secret"), {
      bearerToken: "token-secret",
      headers: { Authorization: "top-secret" },
      env: { API_KEY: "env-secret" },
    });
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("token-secret");
    expect(message).not.toContain("top-secret");
    expect(message).not.toContain("env-secret");
  });
});
