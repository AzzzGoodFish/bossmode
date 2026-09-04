/**
 * Batch 7 closeout: the platform extension API is gone — 404, not 410
 * (retirement pattern: remove outright, no compat layer).
 * Lives in its own file: test-server's vi.mock pins shared/config file-wide.
 */
import { describe, expect, it } from "vitest";
import { createTestServer, jsonRequest, loginAndGetToken, closeTestServer } from "../helpers/test-server.js";

describe("platform extension API retirement", () => {
  it("/api/extensions is gone (404)", async () => {
    const ts = await createTestServer();
    const token = await loginAndGetToken(ts.port);
    const res = await jsonRequest(ts.port, "GET", "/api/extensions", { token });
    expect(res.status).toBe(404);
    const install = await jsonRequest(ts.port, "POST", "/api/extensions/install", { token, body: { package: "npm:pi-web-access" } });
    expect(install.status).toBe(404);
    await closeTestServer(ts);
  });
});
