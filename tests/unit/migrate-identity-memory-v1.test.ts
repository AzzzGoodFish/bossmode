/**
 * scripts/migrate-identity-memory-v1.mjs — dry-run + apply against a fixture tree.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/migrate-identity-memory-v1.mjs", import.meta.url),
);

let boss: string;

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, BOSSMODE_DIR: boss, ...env },
    encoding: "utf-8",
  });
}

beforeEach(() => {
  boss = mkdtempSync(join(tmpdir(), "bm-migrate-id-"));
  // Member with persona + scope principles/mainline
  const mid = "mem_test_a";
  mkdirSync(join(boss, "members", mid, "memory", "scopes", "room-abc"), { recursive: true });
  writeFileSync(
    join(boss, "members", mid, "member.json"),
    JSON.stringify({ id: mid, name: "alice" }),
  );
  writeFileSync(join(boss, "members", mid, "memory", "persona.md"), "I am careful.\nShip tests first.\n");
  writeFileSync(join(boss, "members", mid, "memory", "scopes", "room-abc", "principles.md"), "# P\nBe kind.\n");
  writeFileSync(join(boss, "members", mid, "memory", "scopes", "room-abc", "mainline.md"), "## Focus\nShip it\n");

  // Member already contains this persona body — skip merge, still archive persona.md
  const mid2 = "mem_test_b";
  mkdirSync(join(boss, "members", mid2, "memory"), { recursive: true });
  writeFileSync(
    join(boss, "members", mid2, "member.md"),
    "---\nname: bob\n---\n\n## Persona\n\nAlready folded.\n",
  );
  writeFileSync(join(boss, "members", mid2, "memory", "persona.md"), "Already folded.\n");

  // Library docs
  mkdirSync(join(boss, "knowledge", "docs", "bossmode"), { recursive: true });
  writeFileSync(join(boss, "knowledge", "docs", "bossmode", "note.md"), "# Note\n");
  mkdirSync(join(boss, "knowledge", "docs", "empty-dir"), { recursive: true });

  // Room principles
  const rid = "room-xyz";
  mkdirSync(join(boss, "rooms", rid, "memory"), { recursive: true });
  writeFileSync(join(boss, "rooms", rid, "room.json"), JSON.stringify({ id: rid, name: "Boss Room" }));
  writeFileSync(join(boss, "rooms", rid, "memory", "room-principles.md"), "# Room rules\n");
  writeFileSync(join(boss, "rooms", rid, "memory", "extra.md"), "extra lib\n");
});

afterEach(() => {
  rmSync(boss, { recursive: true, force: true });
});

describe("migrate-identity-memory-v1", () => {
  it("dry-run does not write and prints plan", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY-RUN|mode=DRY-RUN/);
    expect(existsSync(join(boss, "members", "mem_test_a", "member.md"))).toBe(false);
    expect(existsSync(join(boss, "members", "mem_test_a", "archive"))).toBe(false);
    expect(existsSync(join(boss, "memory", "projects", "bossmode", "note.md"))).toBe(false);
    expect(existsSync(join(boss, "migrations", "identity-memory-v1.done.json"))).toBe(false);
  });

  it("apply merges persona, archives persona.md + scopes, moves library and room principles", () => {
    const outJson = join(boss, "report.json");
    const r = run(["--apply"], { MIGRATE_JSON_OUT: outJson });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/mode=APPLY/);

    // persona merge
    const md = readFileSync(join(boss, "members", "mem_test_a", "member.md"), "utf-8");
    expect(md).toMatch(/name: alice/);
    expect(md).toContain("## Persona");
    expect(md).toContain("I am careful.");
    expect(md).toContain("Ship tests first.");
    // source moved to archive (file-presence completion)
    expect(existsSync(join(boss, "members", "mem_test_a", "memory", "persona.md"))).toBe(false);
    expect(existsSync(join(boss, "members", "mem_test_a", "archive", "persona.md"))).toBe(true);

    // skip member with persona body already present — still archives persona.md
    const bob = readFileSync(join(boss, "members", "mem_test_b", "member.md"), "utf-8");
    expect(bob).toContain("Already folded.");
    expect((bob.match(/Already folded\./g) || []).length).toBe(1);
    expect(existsSync(join(boss, "members", "mem_test_b", "memory", "persona.md"))).toBe(false);
    expect(existsSync(join(boss, "members", "mem_test_b", "archive", "persona.md"))).toBe(true);

    // archive scopes
    expect(existsSync(join(boss, "members", "mem_test_a", "archive", "principles-room-abc.md"))).toBe(true);
    expect(existsSync(join(boss, "members", "mem_test_a", "archive", "mainline-room-abc.md"))).toBe(true);
    expect(existsSync(join(boss, "members", "mem_test_a", "memory", "scopes", "room-abc", "principles.md"))).toBe(false);

    // library
    expect(existsSync(join(boss, "memory", "projects", "bossmode", "note.md"))).toBe(true);

    // room archive
    expect(existsSync(join(boss, "memory", "projects", "archive", "boss-room", "room-principles.md"))).toBe(true);
    expect(existsSync(join(boss, "memory", "projects", "archive", "boss-room", "extra.md"))).toBe(true);

    // marker
    expect(existsSync(join(boss, "migrations", "identity-memory-v1.done.json"))).toBe(true);
    const report = JSON.parse(readFileSync(outJson, "utf-8"));
    expect(report.apply).toBe(true);
    expect(report.actions.length).toBeGreaterThan(5);

    // backup exists
    expect(report.backupDir).toBeTruthy();
    expect(existsSync(report.backupDir as string)).toBe(true);
  });

  it("apply twice is idempotent — no duplicated Persona, body unchanged", () => {
    expect(run(["--apply"]).status).toBe(0);
    const md1 = readFileSync(join(boss, "members", "mem_test_a", "member.md"), "utf-8");
    const personaHits1 = (md1.match(/## Persona/g) || []).length;
    expect(personaHits1).toBe(1);

    const r2 = run(["--apply"]);
    expect(r2.status).toBe(0);
    const md2 = readFileSync(join(boss, "members", "mem_test_a", "member.md"), "utf-8");
    expect(md2).toBe(md1);
    expect((md2.match(/## Persona/g) || []).length).toBe(1);
    expect((md2.match(/I am careful\./g) || []).length).toBe(1);
    // persona source stays gone
    expect(existsSync(join(boss, "members", "mem_test_a", "memory", "persona.md"))).toBe(false);
  });
});
