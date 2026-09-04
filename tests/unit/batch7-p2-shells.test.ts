/**
 * Batch 7 P2 (spec §6): persistent shells — real PTY lifecycle, completion
 * marker with exit code, line-numbered reads, background continuation, keys,
 * dead honesty, member scoping. These tests spawn REAL shells (node-pty).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-b7p2-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members", "mem_sh"), { recursive: true });
  vi.resetModules();
});
afterEach(async () => {
  const m = await import("../../src/engine/shell-manager.js");
  m.closeAllShellsForMember("mem_sh");
  m.closeAllShellsForMember("mem_other");
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

async function fresh() {
  return import("../../src/engine/shell-manager.js");
}

describe("persistent shell (real PTY)", () => {
  it("create → exec with marker exit code and line numbers → read by line range", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shellId = created.shell;

    const done = await sm.execInShell({ memberId: "mem_sh", shell: shellId, command: "echo alpha; echo beta; true", blockUntilMs: 8000 });
    expect(done.ok && done.status).toBe("done");
    if (done.ok && done.status === "done") {
      expect(done.exitCode).toBe(0);
      expect(done.output).toContain("alpha");
      expect(done.output).toContain("beta");
      expect(typeof done.lineStart).toBe("number");
      expect(done.lineEnd).toBeGreaterThanOrEqual(done.lineStart);
    }

    const failed = await sm.execInShell({ memberId: "mem_sh", shell: shellId, command: "sh -c 'exit 7'", blockUntilMs: 8000 });
    expect(failed.ok && failed.status === "done" && failed.exitCode).toBe(7);
  }, 15000);

  it("cwd persists between execs — the human terminal property", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.shell;
    await sm.execInShell({ memberId: "mem_sh", shell: s, command: `cd ${dir}`, blockUntilMs: 8000 });
    const where = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "pwd", blockUntilMs: 8000 });
    expect(where.ok && where.status === "done" && where.output.trim()).toBe(dir);
  }, 15000);

  it("shell_wait: timeout returns running with progress; 0 waits to completion (design v1.1)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.shell;

    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 1.5; echo WAIT-DONE", blockUntilMs: 0 });
    expect(started.ok && started.status).toBe("running");
    const execId = started.ok ? started.exec : "e1";

    // Short budget runs out while the command is still going → running + note.
    const early = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: execId, blockUntilMs: 200 });
    expect(early.ok && early.status).toBe("running");

    // 0 = wait until completion → done + exit code + output.
    const done = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: execId, blockUntilMs: 0 });
    expect(done.ok && done.status).toBe("done");
    if (done.ok && done.status === "done") {
      expect(done.exitCode).toBe(0);
      expect(done.output).toContain("WAIT-DONE");
    }

    // A finished exec answers immediately (history lookup path).
    const again = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: execId, blockUntilMs: 50 });
    expect(again.ok && again.status).toBe("done");

    // Unknown exec → honest error.
    const missing = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: "e999" });
    expect(missing.ok).toBe(false);
  }, 15000);

  it("cwd receipt: cd prints one receipt line; no cd, no receipt (fish 2026-09-04)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.shell;
    const sub = join(dir, "receipt-sub");
    mkdirSync(sub, { recursive: true });

    // A plain command in the startup cwd: baseline was recorded silently, no receipt.
    const idle = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo idle-ok", blockUntilMs: 8000 });
    expect(idle.ok && idle.output).not.toContain("cwd:");
    const home = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "pwd", blockUntilMs: 8000 });
    const startCwd = home.ok && home.status === "done" ? home.output.trim() : "";

    // cd away: the exec that moved gets exactly one receipt line naming old → new.
    const moved = await sm.execInShell({ memberId: "mem_sh", shell: s, command: `cd ${sub}`, blockUntilMs: 8000 });
    expect(moved.ok && moved.output).toContain(`cwd: ${startCwd} → ${sub}`);

    // Staying put: no new receipt.
    const stay = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "pwd", blockUntilMs: 8000 });
    expect(stay.ok && stay.output.trim()).toBe(sub);
    expect(stay.ok && stay.output).not.toContain("cwd:");

    // cd back: receipt again, reversed.
    const back = await sm.execInShell({ memberId: "mem_sh", shell: s, command: `cd ${dir}`, blockUntilMs: 8000 });
    expect(back.ok && back.output).toContain(`cwd: ${sub} → ${dir}`);
  }, 15000);

  it("blockUntilMs: 0 returns running immediately — the command keeps running (qa rc.20 Major)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.shell;

    const startedAt = Date.now();
    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 2; echo ZERO-BG-DONE", blockUntilMs: 0 });
    const elapsed = Date.now() - startedAt;
    expect(started.ok && started.status).toBe("running");
    // "never block" means immediate return, not a hang until the command ends.
    expect(elapsed).toBeLessThan(1000);

    // The command keeps running in the background and shell_read collects it.
    await new Promise((r) => setTimeout(r, 2600));
    const read = sm.readShell({ memberId: "mem_sh", shell: s, exec: started.ok ? started.exec : "e1" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      const text = read.lines.map((l) => l.text).join("\n");
      expect(text).toContain("ZERO-BG-DONE");
    }
  }, 15000);

  it("long commands go to background at blockUntilMs and finish later", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.shell;
    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 1.2; echo LATE-DONE", blockUntilMs: 300 });
    expect(started.ok && started.status).toBe("running");

    await new Promise((r) => setTimeout(r, 1800));
    const read = sm.readShell({ memberId: "mem_sh", shell: s, exec: started.ok ? started.exec : "e1" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      const text = read.lines.map((l) => l.text).join("\n");
      expect(text).toContain("LATE-DONE");
    }
  }, 15000);

  it("ctrl-c interrupts a running command; history stays clean of wrappers", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.shell;
    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 30; echo NEVER", blockUntilMs: 300 });
    expect(started.ok && started.status).toBe("running");
    const interrupted = await sm.execInShell({ memberId: "mem_sh", shell: s, keys: "ctrl-c", blockUntilMs: 0 });
    expect(interrupted.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400));

    // fish's rule: no wrapper ever appended to a command — the sleep line
    // enters history exactly as sent (the one-time init line is the only
    // shell-machinery entry, and it is a plain command, not an injection).
    const hist = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "history 6 | grep -c 'BM_EXE[C]'", blockUntilMs: 8000 });
    if (hist.ok && hist.status === "done") {
      expect(hist.output.trim()).toBe("0");
    }
  }, 15000);

  it("close kills the shell; dead references fail honestly; shells are member-scoped", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh", name: "builder" });
    if (!created.ok) return;
    const s = created.shell;

    expect(sm.listShells("mem_sh")).toHaveLength(1);
    expect(sm.listShells("mem_other")).toHaveLength(0);

    expect(sm.closeShell("mem_sh", s).ok).toBe(true);
    const after = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo x", blockUntilMs: 1000 });
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.error).toContain("not found");
    expect(sm.listShells("mem_sh")).toHaveLength(0);
  }, 10000);
});
