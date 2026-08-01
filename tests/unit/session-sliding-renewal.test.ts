/**
 * C1: session sliding renewal — active use extends TTL; idle still expires at 24h.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;
const TEST_USER = "user";
const TEST_PASS = "pass";

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  const passwordHash = actual.hashPassword(TEST_PASS);
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
    readConfig: () => ({
      auth: { username: TEST_USER, passwordHash },
      runtime: { sessionResume: true },
    }),
  };
});

describe("session sliding renewal", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-session-"));
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      const auth = await import("../../src/api/auth.js");
      auth.clearSessionsForTests();
    } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not renew when more than half TTL remains", async () => {
    const auth = await import("../../src/api/auth.js");
    const session = auth.login(TEST_USER, TEST_PASS);
    expect(session).toBeTruthy();
    const token = session!.token;
    const before = auth.getSessionExpiresAtForTests(token)!;

    expect(auth.validateToken(token)).toBe(true);
    const after = auth.getSessionExpiresAtForTests(token)!;
    expect(after).toBe(before);
  });

  it("slides expiry to full 24h when remaining < half TTL", async () => {
    const auth = await import("../../src/api/auth.js");
    const session = auth.login(TEST_USER, TEST_PASS);
    expect(session).toBeTruthy();
    const token = session!.token;

    const oneHour = 60 * 60 * 1000;
    auth.setSessionRemainingForTests(token, oneHour);

    expect(auth.validateToken(token)).toBe(true);
    const remaining = auth.getSessionExpiresAtForTests(token)! - Date.now();
    expect(remaining).toBeGreaterThan(auth.SESSION_TTL_MS - 5_000);
    expect(remaining).toBeLessThanOrEqual(auth.SESSION_TTL_MS + 50);
  });

  it("expired token is rejected and removed (no resurrection)", async () => {
    const auth = await import("../../src/api/auth.js");
    const session = auth.login(TEST_USER, TEST_PASS);
    const token = session!.token;
    auth.setSessionRemainingForTests(token, -1_000);
    expect(auth.validateToken(token)).toBe(false);
    expect(auth.getSessionExpiresAtForTests(token)).toBeNull();
    expect(auth.validateToken(token)).toBe(false);
  });

  it("requireAuth uses sliding validateToken", async () => {
    const auth = await import("../../src/api/auth.js");
    const session = auth.login(TEST_USER, TEST_PASS);
    const token = session!.token;
    auth.setSessionRemainingForTests(token, 60 * 60 * 1000);
    expect(auth.requireAuth({ authorization: `Bearer ${token}` })).toBe(true);
    const remaining = auth.getSessionExpiresAtForTests(token)! - Date.now();
    expect(remaining).toBeGreaterThan(auth.SESSION_TTL_MS - 5_000);
  });
});
