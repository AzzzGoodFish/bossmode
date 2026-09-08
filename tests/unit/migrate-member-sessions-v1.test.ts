import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const source = join(root, "legacy.jsonl");
  writeFileSync(source, '{"type":"session","id":"sid","timestamp":"2026-09-07T03:00:00Z"}\n{"type":"message","id":"e"}\n');
  writeFileSync(join(root, "rooms", "room_a", "sessions.json"), JSON.stringify({ [memberId]: { runtime: "pi-sdk", sessionId: "sid", sessionFile: source } }));
  return { memberId, source };
}
function run(mode: "--dry-run" | "--apply") {
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
    expect(run("--apply").at(-1)).toMatchObject({ exitCode: 0, skippedIdentical: 1 });
  });

  it("reports every unresolved owner and performs no migration writes", () => {
    const { source } = fixture();
    writeFileSync(join(root, "orphan.jsonl"), '{"type":"session","id":"orphan","timestamp":"2026-09-07T00:00:00Z"}\n');
    const refs = join(root, "rooms", "room_a", "sessions.json");
    writeFileSync(refs, JSON.stringify({ missing_member: { runtime: "pi-sdk", sessionFile: source } }));
    const result = spawnSync(process.execPath, [script, "--apply", "--bossmode-dir", root], { encoding: "utf8" });
    expect(result.status).toBe(2);
    const rows = result.stdout.trim().split("\n").map(JSON.parse);
    expect(rows.filter((row: any) => row.kind === "conflict")).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({ writes: 0, exitCode: 2 });
  });
});
