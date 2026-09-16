import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the pure functions directly; filesystem-dependent tests use temp dirs.

describe("password hashing", () => {
  // Import the functions - they're pure crypto, no fs side effects
  let hashPassword: typeof import("../src/config/config.js").hashPassword;
  let verifyPassword: typeof import("../src/config/config.js").verifyPassword;

  beforeEach(async () => {
    const mod = await import("../src/config/config.js");
    hashPassword = mod.hashPassword;
    verifyPassword = mod.verifyPassword;
  });

  it("should hash and verify password correctly", () => {
    const hash = hashPassword("mypassword");
    expect(hash).toContain(":");
    expect(verifyPassword("mypassword", hash)).toBe(true);
  });

  it("should reject wrong password", () => {
    const hash = hashPassword("mypassword");
    expect(verifyPassword("wrongpassword", hash)).toBe(false);
  });

  it("should produce different hashes for same password (different salt)", () => {
    const hash1 = hashPassword("same");
    const hash2 = hashPassword("same");
    expect(hash1).not.toBe(hash2);
    // But both should verify
    expect(verifyPassword("same", hash1)).toBe(true);
    expect(verifyPassword("same", hash2)).toBe(true);
  });

  it("should handle empty stored hash gracefully", () => {
    expect(verifyPassword("test", "")).toBe(false);
    expect(verifyPassword("test", "nosalt")).toBe(false);
  });
});

describe("resolveApiKey", () => {
  let resolveApiKey: typeof import("../src/config/config.js").resolveApiKey;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    const mod = await import("../src/config/config.js");
    resolveApiKey = mod.resolveApiKey;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("should prefer env var over config", () => {
    process.env.ANTHROPIC_API_KEY = "env-key";
    const config = {
      auth: { username: "test", passwordHash: "x:y" },
      apiKeys: { anthropic: "config-key" },
      defaults: { host: "127.0.0.1", port: 8080 },
    };
    expect(resolveApiKey("anthropic", config)).toBe("env-key");
  });

  it("should fall back to config when env var not set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const config = {
      auth: { username: "test", passwordHash: "x:y" },
      apiKeys: { anthropic: "config-key" },
      defaults: { host: "127.0.0.1", port: 8080 },
    };
    expect(resolveApiKey("anthropic", config)).toBe("config-key");
  });

  it("should return undefined when neither exists", () => {
    delete process.env.OPENAI_API_KEY;
    const config = {
      auth: { username: "test", passwordHash: "x:y" },
      apiKeys: {},
      defaults: { host: "127.0.0.1", port: 8080 },
    };
    expect(resolveApiKey("openai", config)).toBeUndefined();
  });
});

describe("PID file management", () => {
  it("isProcessRunning returns true for current process", async () => {
    const { isProcessRunning } = await import("../src/app/pid.js");
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("isProcessRunning returns false for non-existent PID", async () => {
    const { isProcessRunning } = await import("../src/app/pid.js");
    // PID 999999 is almost certainly not running
    expect(isProcessRunning(999999)).toBe(false);
  });
});
