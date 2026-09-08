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
    expect(expanded.map((record: any) => record.entry.id)).toEqual(["s", "older", "hit"]);
    expect(expanded.at(-1)).toMatchObject({ relation: "anchor", branch: true });
  });

  it("uses the full DM scope and never searches or returns encrypted fields", () => {
    root = mkdtempSync(join(tmpdir(), "session-search-"));
    const member = join(root, "members", "mem_me");
    const file = join(member, "sessions", "2026-09-07", "dm", "one.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, '{"type":"message","id":"e","timestamp":"2026-09-07T00:00:00Z","encrypted_content":"secret-needle","message":{"role":"assistant","content":[{"type":"text","text":"visible"}],"thinkingSignature":"hidden"}}\n');
    expect(run("--member-dir", member, "search", "--text", "secret-needle", "--scope", "dm:mem_me")).toEqual([]);
    const visible = run("--member-dir", member, "search", "--text", "visible", "--scope", "dm:mem_me");
    expect(visible[0].scope).toBe("dm:mem_me");
    expect(JSON.stringify(visible)).not.toMatch(/thinkingSignature|encrypted_content|hidden|secret-needle/);
  });

  it("always returns a usable cursor when the byte budget truncates output", () => {
    root = mkdtempSync(join(tmpdir(), "session-search-"));
    const member = join(root, "members", "mem_me");
    const file = join(member, "sessions", "2026-09-07", "rooms", "r", "one.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: "message", id: `e${i}`, timestamp: "2026-09-07T00:00:00Z", message: { role: "user", content: `needle ${"中".repeat(100)}` } })).join("\n") + "\n");
    const first = run("--member-dir", member, "search", "--text", "needle", "--max-bytes", "1024");
    expect(first.at(-1)).toMatchObject({ kind: "truncated", reason: "max-bytes" });
    expect(first.at(-1).nextCursor).toBeTruthy();
    const second = run("--member-dir", member, "search", "--text", "needle", "--max-bytes", "1024", "--cursor", first.at(-1).nextCursor);
    expect(second[0].entryId).not.toBe(first[0].entryId);
  });
});
