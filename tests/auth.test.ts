import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock config module for auth tests
vi.mock("../src/store/config.js", () => {
  const hashPassword = (password: string) => {
    const { createHash, randomBytes } = require("node:crypto");
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(salt + password).digest("hex");
    return `${salt}:${hash}`;
  };

  const stored = {
    auth: { username: "fish", passwordHash: hashPassword("secret123") },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 },
  };

  return {
    readConfig: () => stored,
    verifyPassword: (password: string, storedHash: string) => {
      const { createHash, timingSafeEqual } = require("node:crypto");
      const [salt, expectedHash] = storedHash.split(":");
      if (!salt || !expectedHash) return false;
      const hash = createHash("sha256").update(salt + password).digest("hex");
      const a = Buffer.from(hash, "hex");
      const b = Buffer.from(expectedHash, "hex");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },
  };
});

describe("auth", () => {
  let login: typeof import("../src/server/auth.js").login;
  let validateToken: typeof import("../src/server/auth.js").validateToken;
  let extractToken: typeof import("../src/server/auth.js").extractToken;
  let requireAuth: typeof import("../src/server/auth.js").requireAuth;

  beforeEach(async () => {
    const mod = await import("../src/server/auth.js");
    login = mod.login;
    validateToken = mod.validateToken;
    extractToken = mod.extractToken;
    requireAuth = mod.requireAuth;
  });

  it("should login with correct credentials", () => {
    const result = login("fish", "secret123");
    expect(result).not.toBeNull();
    expect(result!.token).toBeTruthy();
    expect(result!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("should reject wrong username", () => {
    expect(login("wrong", "secret123")).toBeNull();
  });

  it("should reject wrong password", () => {
    expect(login("fish", "wrongpassword")).toBeNull();
  });

  it("should validate issued token", () => {
    const result = login("fish", "secret123");
    expect(validateToken(result!.token)).toBe(true);
  });

  it("should reject invalid token", () => {
    expect(validateToken("invalid-token-xxx")).toBe(false);
  });

  it("should extract Bearer token from headers", () => {
    expect(extractToken({ authorization: "Bearer abc123" })).toBe("abc123");
    expect(extractToken({ authorization: "Basic abc123" })).toBeNull();
    expect(extractToken({})).toBeNull();
  });

  it("requireAuth should work with valid Bearer token", () => {
    const result = login("fish", "secret123");
    expect(requireAuth({ authorization: `Bearer ${result!.token}` })).toBe(true);
    expect(requireAuth({ authorization: "Bearer invalid" })).toBe(false);
    expect(requireAuth({})).toBe(false);
  });
});
