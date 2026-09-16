/**
 * Batch 7 P2 (spec §6): persistent terminals — real PTY lifecycle, completion
 * marker with exit code, line-numbered reads, background continuation, keys,
 * dead honesty, member scoping. These tests spawn REAL terminals (node-pty).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { coreFixture } from "../helpers/core-fixture.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
beforeEach(() => {
  fixture=coreFixture();dir=fixture.root;
  for(const id of ["mem_sh","mem_other"]) {
    fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,'general','{}',0,0)",id,id,id);
    mkdirSync(join(dir,"members",id),{recursive:true});
  }
});
afterEach(async () => {
  const m=await import("../../src/engine/shell-manager.js");
  await m.closeAllShellsForMember("mem_sh");await m.closeAllShellsForMember("mem_other");fixture.close();
});

async function fresh() {
  return import("../../src/engine/shell-manager.js");
}

describe("persistent terminal (real PTY)", () => {
  it("one multiline submission stays busy through its last command and preserves shell state", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Terminal creation failed");
    const s = created.terminalId;
    const command = `cd '${dir}'
export BOSS_TEST_VALUE="a single quote: ' and literal value"
cat <<'END'
FIRST-LINE
END
sleep 0.8
printf 'LAST-LINE\\n'
false`;
    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command, blockUntilMs: 150 });
    expect(started.ok && started.status).toBe("running");
    const rejected = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo NOT-SUBMITTED", blockUntilMs: 0 });
    expect(rejected.ok).toBe(false);
    const done = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: "e1", blockUntilMs: 3000 });
    expect(done.ok && done.status).toBe("done");
    if (!done.ok || done.status !== "done") throw new Error("Command did not finish");
    expect(done.exitCode).toBe(1);
    expect(done.output).toContain("FIRST-LINE");
    expect(done.output).toContain("LAST-LINE");
    expect(done.output).not.toContain("NOT-SUBMITTED");
    const state = await sm.execInShell({ memberId: "mem_sh", shell: s, command: 'pwd; printf "%s" "$BOSS_TEST_VALUE"', blockUntilMs: 3000 });
    expect(state.ok && state.exec).toBe("e2");
    expect(state.ok && state.status === "done" && state.output).toContain(dir);
    expect(state.ok && state.status === "done" && state.output).toContain("a single quote: ' and literal value");
  }, 15000);

  it("create → exec with marker exit code and line numbers → read by line range", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const shellId = created.terminalId;

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
    const s = created.terminalId;
    await sm.execInShell({ memberId: "mem_sh", shell: s, command: `cd ${dir}`, blockUntilMs: 8000 });
    const where = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "pwd", blockUntilMs: 8000 });
    expect(where.ok && where.status === "done" && where.output.trim()).toBe(dir);
  }, 15000);

  it("terminal_wait: timeout returns running with progress; 0 waits to completion (design v1.1)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;

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

  it("settleMemberShellWaits ends a blocking wait immediately — running + exec id (qa rc.22 note ①)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;

    // A blocking exec (10s budget) on a 3s command: normally the tool call
    // holds until the command ends. The interrupt settle must end the wait
    // in milliseconds and return running + the exec id.
    const waitPromise = sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 3; echo SETTLE-DONE", blockUntilMs: 10000 });
    await new Promise((r) => setTimeout(r, 150));
    sm.settleMemberShellWaits("mem_sh");
    const startedAt = Date.now();
    const result = await waitPromise;
    const elapsed = Date.now() - startedAt;
    expect(result.ok && result.status).toBe("running");
    expect(elapsed).toBeLessThan(1000);
    if (result.ok && result.status === "running") {
      expect(result.note).toContain("terminal_wait");
    }

    // The command itself kept running: wait for it and get the full record.
    const execId = result.ok ? result.exec : "e1";
    const done = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: execId, blockUntilMs: 0 });
    expect(done.ok && done.status).toBe("done");
    if (done.ok && done.status === "done") {
      expect(done.exitCode).toBe(0);
      expect(done.output).toContain("SETTLE-DONE");
    }
  }, 15000);

  it("cwd receipt: cd prints one receipt line; no cd, no receipt (fish 2026-09-04)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;
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
    const s = created.terminalId;

    const startedAt = Date.now();
    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 2; echo ZERO-BG-DONE", blockUntilMs: 0 });
    const elapsed = Date.now() - startedAt;
    expect(started.ok && started.status).toBe("running");
    // "never block" means immediate return, not a hang until the command ends.
    expect(elapsed).toBeLessThan(1000);

    // The command keeps running in the background and terminal_read collects it.
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
    const s = created.terminalId;
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

  it("read by exec returns the command's own lines after earlier output (window regression)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;

    // Let the shell's own startup output settle: the exec is then submitted
    // while the shell already holds a trailing line — the real-world condition
    // under which read-by-exec used to skip the command's own output.
    await new Promise((r) => setTimeout(r, 900));

    const first = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo ONE", blockUntilMs: 8000 });
    expect(first.ok && first.status).toBe("done");
    const w1 = sm.readShell({ memberId: "mem_sh", shell: s, exec: first.ok ? first.exec : "e1" });
    expect(w1.ok && w1.status === "done").toBe(true);
    if (w1.ok && w1.status === "done") {
      const text = w1.lines.map((l) => l.text).join("\n");
      expect(text).toContain("ONE");
    }

    const second = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo TWO", blockUntilMs: 8000 });
    expect(second.ok && second.status).toBe("done");
    const w2 = sm.readShell({ memberId: "mem_sh", shell: s, exec: second.ok ? second.exec : "e2" });
    expect(w2.ok && w2.status === "done").toBe(true);
    if (w2.ok && w2.status === "done") {
      const text = w2.lines.map((l) => l.text).join("\n");
      expect(text).toContain("TWO");
      expect(text).not.toContain("ONE");
    }
  }, 15000);

  it("read by exec collects a backgrounded command's output after earlier shell output", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;
    await new Promise((r) => setTimeout(r, 900));

    const bg = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 1; echo LATE-BG", blockUntilMs: 0 });
    expect(bg.ok && bg.status).toBe("running");
    const execId = bg.ok ? bg.exec : "e1";
    const done = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: execId, blockUntilMs: 5000 });
    expect(done.ok && done.status).toBe("done");
    const read = sm.readShell({ memberId: "mem_sh", shell: s, exec: execId });
    expect(read.ok && read.status === "done").toBe(true);
    if (read.ok && read.status === "done") {
      const text = read.lines.map((l) => l.text).join("\n");
      expect(text).toContain("LATE-BG");
    }
  }, 15000);

  it("busy shell rejects a new command: no exec allocated, nothing queued, read/wait still work (fish 2026-09-05)", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;

    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 1.2; echo BUSY-DONE", blockUntilMs: 0 });
    expect(started.ok && started.status).toBe("running");
    const busyExec = started.ok ? started.exec : "e1";
    expect(busyExec).toBe("e1");

    // A second command on the SAME shell is explicitly rejected — not queued.
    const rejected = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo REJECTED-MARKER", blockUntilMs: 0 });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error).toContain("busy");
      expect(rejected.error).toContain(busyExec);
      expect(rejected.error).toContain("NOT submitted");
      expect(rejected.error).not.toContain("e2");
    }

    // read and wait stay available while busy.
    const peek = sm.readShell({ memberId: "mem_sh", shell: s, fromLine: 1 });
    expect(peek.ok).toBe(true);
    const waited = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: busyExec, blockUntilMs: 8000 });
    expect(waited.ok && waited.status).toBe("done");

    // After settling, the NEXT command gets e2 — the rejected one never
    // consumed an id and never ran.
    const after = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo AFTER-CLEAR", blockUntilMs: 8000 });
    expect(after.ok && after.exec).toBe("e2");
    const all = sm.readShell({ memberId: "mem_sh", shell: s, fromLine: 1, toLine: 999 });
    expect(all.ok).toBe(true);
    if (all.ok) {
      const text = all.lines.map((l) => l.text).join("\n");
      expect(text).toContain("AFTER-CLEAR");
      expect(text).not.toContain("REJECTED-MARKER");
    }
  }, 20000);

  it("busy rejection is per shell — another shell runs in parallel", async () => {
    const sm = await fresh();
    const a = await sm.createShell({ memberId: "mem_sh" });
    const b = await sm.createShell({ memberId: "mem_sh" });
    if (!a.ok || !b.ok) return;

    const started = await sm.execInShell({ memberId: "mem_sh", shell: a.terminalId, command: "sleep 1.2; echo A-DONE", blockUntilMs: 0 });
    expect(started.ok && started.status).toBe("running");

    const parallel = await sm.execInShell({ memberId: "mem_sh", shell: b.terminalId, command: "echo B-DONE", blockUntilMs: 8000 });
    expect(parallel.ok && parallel.status).toBe("done");
    if (parallel.ok && parallel.status === "done") {
      expect(parallel.output).toContain("B-DONE");
    }

    const settled = await sm.waitShell({ memberId: "mem_sh", shell: a.terminalId, exec: started.ok ? started.exec : "e1", blockUntilMs: 8000 });
    expect(settled.ok && settled.status).toBe("done");
  }, 20000);

  it("ctrl-c interrupts a running command; history stays clean of wrappers", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh" });
    if (!created.ok) return;
    const s = created.terminalId;
    const started = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "sleep 30; echo NEVER", blockUntilMs: 300 });
    expect(started.ok && started.status).toBe("running");
    const interrupted = await sm.execInShell({ memberId: "mem_sh", shell: s, keys: "ctrl-c", blockUntilMs: 0 });
    expect(interrupted.ok).toBe(true);
    const done = await sm.waitShell({ memberId: "mem_sh", shell: s, exec: "e1", blockUntilMs: 3000 });
    expect(done.ok && done.status).toBe("done");
    if (!done.ok || done.status !== "done") throw new Error("Interrupted exec did not settle");
    expect(done.exitCode).toBe(130);
    expect(done.output).not.toContain("NEVER");

    // The original command, not an eval/marker wrapper, enters history.
    const hist = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "history 6", blockUntilMs: 8000 });
    expect(hist.ok && hist.status).toBe("done");
    if (!hist.ok || hist.status !== "done") throw new Error("History read failed");
    expect(hist.output).toMatch(/\d+\s+sleep 30/);
    expect(hist.output).not.toContain("eval '");
    expect(hist.output).not.toContain("BM_EXEC");
  }, 15000);

  it("close kills the shell; dead references fail honestly; shells are member-scoped", async () => {
    const sm = await fresh();
    const created = await sm.createShell({ memberId: "mem_sh", name: "builder" });
    if (!created.ok) return;
    const s = created.terminalId;

    expect(sm.listShells("mem_sh")).toHaveLength(1);
    expect(sm.listShells("mem_other")).toHaveLength(0);

    expect((await sm.closeShell("mem_sh", s)).ok).toBe(true);
    const after = await sm.execInShell({ memberId: "mem_sh", shell: s, command: "echo x", blockUntilMs: 1000 });
    expect(after.ok).toBe(false);
    expect(after.ok === false && after.error).toContain("not found");
    expect(sm.listShells("mem_sh")).toHaveLength(0);
  }, 10000);
});

it("unlimited terminal_wait is interruptible and close settles outstanding exec completion",async()=>{
  const sm=await fresh();const created=await sm.createShell({memberId:"mem_sh"});
  if(!created.ok)throw new Error(created.error);
  const exec=await sm.execInShell({memberId:"mem_sh",shell:created.terminalId,command:"sleep 30",blockUntilMs:0});
  if(!exec.ok)throw new Error(exec.error);
  const wait=sm.waitShell({memberId:"mem_sh",shell:created.terminalId,exec:exec.exec,blockUntilMs:0});
  sm.settleMemberShellWaits("mem_sh");expect((await wait).status).toBe("running");
  const ending=sm.waitShell({memberId:"mem_sh",shell:created.terminalId,exec:exec.exec,blockUntilMs:0});
  await sm.closeShell("mem_sh",created.terminalId);expect((await ending).status).toBe("done");
});
