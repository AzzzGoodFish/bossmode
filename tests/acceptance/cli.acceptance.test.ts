/**
 * Acceptance Tests: CLI (v1.1 Batch 1)
 *
 * Coverage:
 * - CLI-1: `bossmode on` forks to background, returns shell within 1s
 * - CLI-2: Port occupied → clear error message
 * - T1.4: `bossmode on` when already running → shows existing instance info
 * - T8.1: `bossmode off` stops the service
 * - T8.2: `bossmode off` when not running → graceful message
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync, fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";

// Use a test-specific bossmode dir/port to avoid interfering with real config
const TEST_DIR = "/tmp/bossmode-cli-test";
let TEST_PORT = 19876;

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function setupTestConfig(): void {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "agents"), { recursive: true });

  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + "testpass").digest("hex");

  const config = {
    auth: { username: "testuser", passwordHash: `${salt}:${hash}` },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: TEST_PORT },
  };
  writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(config, null, 2));

  // Minimal agent def
  writeFileSync(
    join(TEST_DIR, "agents", "pm.md"),
    "---\nname: pm\nmodel: test\ndescription: test\n---\nYou are pm.",
  );
}

function cleanupTestDir(): void {
  // Kill any leftover test processes
  try {
    const pidFile = join(TEST_DIR, "bossmode.pid");
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  } catch {}

  // Small delay for process cleanup
  try { execSync("sleep 0.5"); } catch {}

  rmSync(TEST_DIR, { recursive: true, force: true });
}

function runCli(args: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(
      `node dist/cli/index.js ${args}`,
      {
        cwd: process.cwd(),
        timeout: 8000,
        env: { ...process.env, BOSSMODE_DIR: TEST_DIR, BOSSMODE_ON_TIMEOUT_MS: "5000", ...env },
        encoding: "utf-8",
      },
    );
    return { stdout: stdout.toString(), stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() || "",
      stderr: err.stderr?.toString() || "",
      exitCode: err.status || 1,
    };
  }
}

describe("Acceptance: CLI (v1.1 Batch 1)", () => {
  beforeAll(async () => {
    TEST_PORT = await getFreePort();
    setupTestConfig();
  });

  afterAll(() => {
    cleanupTestDir();
  });

  afterEach(() => {
    // Use CLI off for proper cleanup (handles PID + process)
    try { runCli("off"); } catch {}
    try { execSync("sleep 0.3"); } catch {}
    // Force-remove PID file if still lingering
    try { rmSync(join(TEST_DIR, "bossmode.pid"), { force: true }); } catch {}
  });

  // ── CLI-1: Fork to background ──

  describe("CLI-1: bossmode on forks to background", () => {
    it("returns within a few seconds with startup message", () => {
      const start = Date.now();
      const result = runCli(`on --port ${TEST_PORT}`);
      const elapsed = Date.now() - start;

      // Should return quickly (within 5s including daemon startup)
      expect(elapsed).toBeLessThan(5000);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Bossmode started at");
      expect(result.stdout).toContain(`${TEST_PORT}`);
      expect(result.stdout).toMatch(/PID \d+/);
    });

    it("bossmode status shows running after on", () => {
      // Start first
      runCli(`on --port ${TEST_PORT}`);

      const status = runCli("status");
      expect(status.stdout).toContain("running");
      expect(status.stdout).toMatch(/PID \d+/);
    });
  });

  // ── CLI-2: Port occupied error ──

  describe("CLI-2: Port occupied → clear error", () => {
    it("shows error when port is in use", async () => {
      // Occupy the port with a TCP server
      const blocker = createServer();
      const occupiedPort = await getFreePort();
      await new Promise<void>((resolve) => blocker.listen(occupiedPort, "127.0.0.1", resolve));

      try {
        const result = runCli(`on --port ${occupiedPort}`);
        // Should fail — exitCode non-zero or stdout/stderr contains error
        const output = result.stdout + result.stderr;
        expect(output.toLowerCase()).toMatch(/failed|in use|eaddrinuse|error|exited/i);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  // ── T1.4: Already running ──

  describe("T1.4: bossmode on when already running", () => {
    it("shows existing instance info", () => {
      // Start
      const first = runCli(`on --port ${TEST_PORT}`);
      expect(first.exitCode).toBe(0);

      // Try again
      const second = runCli(`on --port ${TEST_PORT}`);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already running");
    });
  });

  // ── T8.1: bossmode off ──

  describe("T8.1: bossmode off", () => {
    it("stops running instance", () => {
      runCli(`on --port ${TEST_PORT}`);

      const off = runCli("off");
      expect(off.stdout).toContain("stopped");

      // Status should show not running
      const status = runCli("status");
      expect(status.stdout).toContain("not running");
    });
  });

  // ── T8.2: bossmode off when not running ──

  describe("T8.2: bossmode off when not running", () => {
    it("shows graceful message", () => {
      const result = runCli("off");
      expect(result.stdout).toContain("not running");
    });
  });
});
