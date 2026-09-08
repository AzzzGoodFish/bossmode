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
    expect(expanded.map((record: any) => JSON.parse(record.entryChunk).id)).toEqual(["s", "older", "hit"]);
    expect(expanded.at(-1)).toMatchObject({ relation: "anchor", branch: true, entryComplete: true });
  });

  it("uses the full DM scope and never searches or returns encrypted fields", () => {
    root = mkdtempSync(join(tmpdir(), "session-search-"));
    const member = join(root, "members", "mem_me");
    const file = join(member, "sessions", "2026-09-07", "dm", "one.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, '{"type":"session","id":"sid","timestamp":"2026-09-07T00:00:00Z"}\n{"type":"message","id":"e","timestamp":"2026-09-07T00:00:01Z","encrypted_content":"secret-needle","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"call-1","text":"visible"}],"thinkingSignature":"hidden"}}\n');
    expect(run("--member-dir", member, "search", "--text", "secret-needle", "--scope", "dm:mem_me")).toEqual([]);
    const visible = run("--member-dir", member, "search", "--text", "visible", "--scope", "dm:mem_me");
    expect(visible[0]).toMatchObject({ scope: "dm:mem_me", sessionId: "sid", role: "toolResult", toolCallId: "call-1" });
    expect(JSON.stringify(visible)).not.toMatch(/thinkingSignature|encrypted_content|hidden|secret-needle/);
  });

  it("paginates an oversized expand entry with forward progress and reports bad lines", () => {
    root = mkdtempSync(join(tmpdir(), "session-search-"));
    const member = join(root, "members", "mem_me");
    const file = join(member, "sessions", "2026-09-07", "rooms", "r", "one.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, [
      '{"type":"session","id":"sid","timestamp":"2026-09-07T00:00:00Z"}',
      "bad tail",
      JSON.stringify({ type: "message", id: "huge", parentId: "sid", timestamp: "2026-09-07T00:01:00Z", message: { role: "assistant", content: "中".repeat(5000) } }),
    ].join("\n") + "\n");
    const first = run("--member-dir", member, "expand", "--file", "sessions/2026-09-07/rooms/r/one.jsonl", "--entry", "huge", "--max-bytes", "1024");
    expect(first.some((row: any) => row.kind === "diagnostic" && row.reason === "invalid-jsonl-record")).toBe(true);
    let page = first;
    let cursor = page.at(-1).nextCursor;
    const chunks = page.filter((row: any) => row.kind === "expand" && row.relation === "anchor").map((row: any) => row.entryChunk);
    const seen = new Set<string>();
    for (let pages = 0; cursor && pages < 100; pages++) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
      page = run("--member-dir", member, "expand", "--file", "sessions/2026-09-07/rooms/r/one.jsonl", "--entry", "huge", "--max-bytes", "1024", "--cursor", cursor);
      chunks.push(...page.filter((row: any) => row.kind === "expand" && row.relation === "anchor").map((row: any) => row.entryChunk));
      cursor = page.at(-1)?.kind === "truncated" ? page.at(-1).nextCursor : undefined;
    }
    expect(cursor).toBeUndefined();
    const restored = JSON.parse(chunks.join(""));
    expect(restored).toMatchObject({ id: "huge", message: { content: "中".repeat(5000) } });
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
