import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(process.cwd(), "assets/skills/bossmode-guide/scripts/session-search.mjs");
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function run(...args: string[]) { return execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(JSON.parse); }

describe("session-search guide script", () => {
  it("searches records appended after the archive start day and expands the entry branch", () => {
    root = mkdtempSync(join(tmpdir(), "session-search-"));
    const member = join(root, "members", "rm_me");
    const file = join(member, "sessions", "2026-09-07", "rooms", "room_a", "one.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, [
      '{"type":"session","id":"s","timestamp":"2026-09-07T23:00:00Z"}',
      '{"type":"message","id":"older","parentId":"s","timestamp":"2026-09-07T23:01:00Z","message":{"role":"user","content":"old"}}',
      '{"type":"message","id":"hit","parentId":"older","timestamp":"2026-09-08T00:01:00Z","message":{"role":"assistant","content":"中文目标"}}',
    ].join("\n") + "\n");
    const found = run("--member-dir", member, "search", "--text", "中文目标", "--from", "2026-09-08T00:00:00Z");
    expect(found[0]).toMatchObject({ file: "sessions/2026-09-07/rooms/room_a/one.jsonl", entryId: "hit", scope: "room:room_a" });
    const expanded = run("--member-dir", member, "expand", "--file", found[0].file, "--entry", "hit", "--before", "2");
    expect(expanded[0].ancestors.map((entry: any) => entry.id)).toEqual(["s", "older", "hit"]);
  });
});
