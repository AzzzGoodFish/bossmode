import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const script = join(process.cwd(), "scripts/migrate-member-sessions-v1.mjs");
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
function fixture() {
  root = mkdtempSync(join(tmpdir(), "session-migration-"));
  const memberId = "mem_123";
  mkdirSync(join(root, "members", memberId), { recursive: true });
  mkdirSync(join(root, "rooms", "room_a"), { recursive: true });
  const source = join(root, "pi-agent", "runtime", "room_a", memberId, "sessions", "legacy.jsonl");
  mkdirSync(join(source, ".."), { recursive: true });
  writeFileSync(source, '{"type":"session","id":"sid","timestamp":"2026-09-07T03:00:00Z"}\n{"type":"message","id":"e"}\n');
  writeFileSync(join(root, "rooms", "room_a", "sessions.json"), JSON.stringify({ [memberId]: { runtime: "pi-sdk", sessionId: "sid", sessionFile: source } }));
  return { memberId, source };
}
function run(mode: "--dry-run" | "--apply" | "--recover") {
  return execFileSync(process.execPath, [script, mode, "--bossmode-dir", root], { encoding: "utf8" }).trim().split("\n").map(JSON.parse);
}
describe("member session migration", () => {
  it("dry-run writes nothing; apply preserves bytes, switches relative current reference, and repeats idempotently", () => {
    const { memberId, source } = fixture();
    const before = hash(source);
    const dry = run("--dry-run");
    expect(dry.at(-1)).toMatchObject({ kind: "summary", writes: 0, exitCode: 0 });
    expect(hash(source)).toBe(before);
    const applied = run("--apply");
    expect(applied.at(-1).exitCode).toBe(0);
    const target = join(root, "members", memberId, "sessions", "2026-09-07", "rooms", "room_a", "legacy.jsonl");
    expect(hash(target)).toBe(before);
    const current = JSON.parse(readFileSync(join(root, "members", memberId, "sessions", "current.json"), "utf8"));
    expect(current["room:room_a"].sessionFile).toBe("sessions/2026-09-07/rooms/room_a/legacy.jsonl");
    const recoveryPath = join(root, "migrations", "member-sessions-v1-recovery.json");
    const recoveryBefore = readFileSync(recoveryPath, "utf8");
    expect(run("--apply")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "apply-skipped", recoveryState: "complete" })]));
    expect(readFileSync(recoveryPath, "utf8")).toBe(recoveryBefore);
    const recovery = JSON.parse(recoveryBefore);
    expect(recovery).toMatchObject({ format: "member-session-recovery/v1", state: "complete" });
  });

  it("uses persisted recovery material idempotently and refuses later current data", () => {
    const { memberId } = fixture();
    run("--apply");
    const currentPath = join(root, "members", memberId, "sessions", "current.json");
    expect(run("--recover").at(-1)).toMatchObject({ exitCode: 0 });
    expect(() => readFileSync(currentPath)).toThrow();
    expect(run("--recover").at(-1)).toMatchObject({ exitCode: 0 });
    const reapplied = run("--apply");
    expect(reapplied).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "recovery-archived", priorState: "recovered" })]));
    expect(JSON.parse(readFileSync(currentPath, "utf8"))["room:room_a"].sessionId).toBe("sid");
    expect(readdirSync(join(root, "migrations", "member-sessions-v1-history"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, "migrations", "member-sessions-v1-recovery.json"), "utf8")).state).toBe("complete");

    writeFileSync(currentPath, JSON.stringify({ "room:room_a": { runtime: "pi-sdk", sessionId: "later" } }));
    const blocked = spawnSync(process.execPath, [script, "--recover", "--bossmode-dir", root], { encoding: "utf8" });
    expect(blocked.status).toBe(2);
    expect(blocked.stdout).toContain("recovery-current-changed");
  });

  it("does not overwrite a current session created before migration", () => {
    const { memberId } = fixture();
    const currentPath = join(root, "members", memberId, "sessions", "current.json");
    mkdirSync(join(currentPath, ".."), { recursive: true });
    const later = { "room:room_a": { runtime: "pi-sdk", sessionId: "later", sessionFile: "sessions/2026-09-08/rooms/room_a/later.jsonl" } };
    writeFileSync(currentPath, JSON.stringify(later));
    const result = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(JSON.parse(readFileSync(currentPath, "utf8"))).toEqual(later);
    expect(result.stdout).toContain("current-session-changed");
  });

  it("blocks apply after interruption and recovery resumes across published and unpublished members", () => {
    const { memberId } = fixture();
    const member2 = "mem_456";
    mkdirSync(join(root, "members", member2), { recursive: true });
    const source2 = join(root, "pi-agent", "runtime", "room_a", member2, "sessions", "legacy2.jsonl");
    mkdirSync(join(source2, ".."), { recursive: true });
    writeFileSync(source2, '{"type":"session","id":"sid2","timestamp":"2026-09-07T03:00:00Z"}\n');
    const refsPath = join(root, "rooms", "room_a", "sessions.json");
    const refs = JSON.parse(readFileSync(refsPath, "utf8"));
    refs[member2] = { runtime: "pi-sdk", sessionId: "sid2", sessionFile: source2 };
    writeFileSync(refsPath, JSON.stringify(refs));
    const failed = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8", env: { ...process.env, BOSSMODE_MIGRATION_TEST_FAIL_AT: "after-copy" } });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("apply-failed");
    expect(() => readFileSync(join(root, "members", memberId, "sessions", "current.json"))).toThrow();

    const interrupted = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8", env: { ...process.env, BOSSMODE_MIGRATION_TEST_FAIL_AT: "after-first-current-publish" } });
    expect(interrupted.status).toBe(86);
    const material = JSON.parse(readFileSync(join(root, "migrations", "member-sessions-v1-recovery.json"), "utf8"));
    expect(material.state).toBe("prepared");
    const reentry = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8" });
    expect(reentry.status).toBe(2);
    expect(reentry.stdout).toContain("unfinished-recovery");
    const interruptedRecovery = spawnSync(process.execPath, [script, "--recover", "--bossmode-dir", root], { encoding: "utf8", env: { ...process.env, BOSSMODE_MIGRATION_TEST_FAIL_AT: "after-first-recovery-item" } });
    expect(interruptedRecovery.status).toBe(87);
    expect(run("--recover").at(-1)).toMatchObject({ exitCode: 0 });
    expect(run("--recover").at(-1)).toMatchObject({ exitCode: 0 });
    expect(() => readFileSync(join(root, "members", memberId, "sessions", "current.json"))).toThrow();
    expect(() => readFileSync(join(root, "members", member2, "sessions", "current.json"))).toThrow();
  });

  it("reports rollback failure and leaves persistent material recoverable", () => {
    const { memberId } = fixture();
    const failed = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8", env: { ...process.env, BOSSMODE_MIGRATION_TEST_FAIL_AT: "publish-and-rollback" } });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("apply-failed");
    expect(failed.stdout).toContain("rollback-failed");
    expect(JSON.parse(readFileSync(join(root, "migrations", "member-sessions-v1-recovery.json"), "utf8")).state).toBe("prepared");
    expect(run("--recover").at(-1)).toMatchObject({ exitCode: 0 });
    expect(() => readFileSync(join(root, "members", memberId, "sessions", "current.json"))).toThrow();
  });

  it("rejects symlinked legacy sources and target ancestors", () => {
    const { memberId, source } = fixture();
    const sourceLink = join(source, "..", "linked.jsonl");
    symlinkSync(source, sourceLink);
    const refsPath = join(root, "rooms", "room_a", "sessions.json");
    writeFileSync(refsPath, JSON.stringify({ [memberId]: { runtime: "pi-sdk", sessionId: "sid", sessionFile: sourceLink } }));
    let result = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("invalid-session-source");

    writeFileSync(refsPath, JSON.stringify({ [memberId]: { runtime: "pi-sdk", sessionId: "sid", sessionFile: source } }));
    const outside = mkdtempSync(join(tmpdir(), "session-target-outside-"));
    const sessions = join(root, "members", memberId, "sessions");
    mkdirSync(sessions, { recursive: true });
    symlinkSync(outside, join(sessions, "2026-09-07"));
    result = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("target ancestor is symlink");
    rmSync(outside, { recursive: true, force: true });
  });

  it("archives legacy member DM files without guessing a current session", () => {
    root = mkdtempSync(join(tmpdir(), "session-migration-"));
    const memberId = "mem_dm";
    mkdirSync(join(root, "members", memberId), { recursive: true });
    const legacy = join(root, "pi-agent", "runtime", "members", memberId, "dm", "sessions", "dm.jsonl");
    mkdirSync(join(legacy, ".."), { recursive: true });
    writeFileSync(legacy, '{"type":"session","id":"dm-sid","timestamp":"2026-09-06T23:00:00Z"}\n');
    const result = run("--apply");
    expect(result.at(-1).exitCode).toBe(0);
    expect(result.find((row: any) => row.kind === "plan")).toMatchObject({ scopeId: `dm:${memberId}`, publishCurrent: false, referenceChange: null });
    expect(readFileSync(join(root, "members", memberId, "sessions", "2026-09-06", "dm", "dm.jsonl"), "utf8")).toBe(readFileSync(legacy, "utf8"));
    expect(() => readFileSync(join(root, "members", memberId, "sessions", "current.json"))).toThrow();
  });

  it("reports every unresolved owner and performs no migration writes", () => {
    const { source } = fixture();
    const orphan = join(root, "pi-agent", "runtime", "orphan", "sessions", "orphan.jsonl");
    mkdirSync(join(orphan, ".."), { recursive: true });
    writeFileSync(orphan, '{"type":"session","id":"orphan","timestamp":"2026-09-07T00:00:00Z"}\n');
    const refs = join(root, "rooms", "room_a", "sessions.json");
    writeFileSync(refs, JSON.stringify({ missing_member: { runtime: "pi-sdk", sessionFile: source } }));
    const result = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8" });
    expect(result.status).toBe(2);
    const rows = result.stdout.trim().split("\n").map(JSON.parse);
    expect(rows.filter((row: any) => row.kind === "conflict")).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({ writes: 0, exitCode: 2 });
  });
});
