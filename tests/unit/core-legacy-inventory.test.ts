import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverLegacyInventory, LegacySourceError, readLegacyJson, readLegacyJsonl,
  validateLegacyPath, validateLegacySources, type LegacyKind,
} from "../../src/data/upgrade/legacy-inventory.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync) };
});
let sandbox: string;
let root: string;
function put(path: string, content: string | Buffer = "{}\n"): string {
  const full = join(root, path);
  fs.mkdirSync(dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
async function all(path: string) {
  return Array.fromAsync(readLegacyJsonl(root, { path }));
}
beforeEach(() => {
  sandbox = fs.mkdtempSync(join(tmpdir(), "legacy-inventory-"));
  root = join(sandbox, "source");
  fs.mkdirSync(root);
  fs.mkdirSync(join(sandbox, "knowledge"));
  vi.clearAllMocks();
});
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe("startup inventory", () => {
  it("discovers rc.28/rc.1 metadata without parsing, writing, choosing generations or name identities", () => {
    const sources: [string, LegacyKind][] = [
      ["config.json", "config"], ["model-credentials.json", "model-credentials"],
      ["pi-catalog-remote.json", "catalog-remote"], ["pi-models-store-overlays.json", "catalog-overlays"],
      ["mcp/mcp.json", "mcp-config"], ["mcp/status.json", "mcp-status"],
      ["members/mem_a/member.json", "member-metadata"], ["members/mem_a/member.md", "member-profile-mixed"],
      ["members/mem_a/mcp.json", "member-mcp"], ["members/mem_a/workspaces.json", "workspaces"],
      ["members/mem_a/ssh/id_ed25519", "ssh-private-key"], ["members/mem_a/ssh/id_ed25519.pub", "ssh-public-key"],
      ["members/mem_a/ssh/config", "ssh-config"], ["agents/old-slug.md", "agent-template-mixed"],
      ["rooms/r/room.json", "room-metadata"], ["rooms/r/tasks.json", "tasks"],
      ["rooms/r/messages.jsonl", "messages"], ["rooms/r/.seq", "message-sequence"], ["rooms/r/cursors.json", "member-cursors"],
      ["members/mem_a/dm-messages.jsonl", "messages"], ["members/mem_a/.dm-seq", "message-sequence"], ["members/mem_a/dm-cursor.json", "dm-member-cursor"],
      ["members/mem_b/dm-messages.jsonl", "messages"],
      ["rooms/r/topics/t/topic.json", "topic-metadata"], ["rooms/r/topics/t/messages.jsonl", "messages"],
      ["rooms/r/topics/t/.topic-seq", "message-sequence"], ["rooms/r/topics/t/cursors.json", "member-cursors"],
      ["rooms/r/agent-events/old-name.jsonl", "agent-events"], ["rooms/r/agent-events/mem_a.jsonl", "agent-events"],
      ["rooms/dm:mem_a/agent-events/old-name.jsonl", "agent-events"], ["rooms/dm:mem_b/agent-events/mem_b.jsonl", "agent-events"],
      ["rooms/r/topics/t/agent-events/old-name.jsonl", "agent-events"],
      ["rooms/r/agent-events/.stats.json", "derived-event-stats"], ["rooms/dm:mem_a/agent-events/.stats.json", "derived-event-stats"],
      ["rooms/r/topics/t/agent-events/.stats.json", "derived-event-stats"],
      ["rooms/r/archives/1700000000000.jsonl", "message-archive"], ["rooms/r/archives/1700000000000.summary.json", "message-archive-summary"],
      ["rooms/dm:mem_a/archives/123.jsonl", "message-archive"], ["rooms/r/topics/t/archives/124.summary.json", "message-archive-summary"],
      ["members/mem_a/sessions/current.json", "current-sessions"], ["rooms/r/sessions.json", "old-sessions"],
      ["rooms/r/topics/t/sessions.json", "old-sessions"], ["rooms/r/runtime-state.json", "runtime-state"],
      ["members/mem_a/runtime-state.json", "runtime-state"], ["rooms/runtime-state.json", "runtime-state"], ["user-read-cursors.json", "user-cursors"],
      ["members/mem_a/background-tasks/2026-09-09/bgt-123/task.json", "background-task"],
    ];
    for (const [path] of [...sources].reverse()) put(path, "UNPARSED secret-bearing bytes");
    const expectedMtime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(join(root, "config.json"), expectedMtime, expectedMtime);
    vi.clearAllMocks();
    const inventory = discoverLegacyInventory(root);
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.entries.map(e => [e.path, e.kind])).toEqual(sources.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    expect(inventory.entries.every(e => e.retire && e.size === Buffer.byteLength("UNPARSED secret-bearing bytes"))).toBe(true);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    const byPath = Object.fromEntries(inventory.entries.map(e => [e.path, e]));
    expect(byPath["config.json"].mtimeMs).toBe(expectedMtime.getTime());
    expect(byPath["members/mem_b/dm-messages.jsonl"].scopeId).toBe("dm:mem_b");
    expect(byPath["rooms/r/topics/t/messages.jsonl"].scopeId).toBe("topic:t");
    expect(byPath["rooms/dm:mem_a/agent-events/old-name.jsonl"]).toMatchObject({ scopeId: "dm:mem_a", ownerKey: "old-name" });
    expect(byPath["rooms/r/agent-events/mem_a.jsonl"].memberId).toBeUndefined();
    expect(byPath["rooms/runtime-state.json"].scopeId).toBeUndefined();
    expect(byPath["members/mem_a/runtime-state.json"].scopeId).toBeUndefined();
    expect(byPath["members/mem_a/background-tasks/2026-09-09/bgt-123/task.json"]).toMatchObject({ memberId: "mem_a", taskId: "bgt-123", sessionDir: "members/mem_a/background-tasks/2026-09-09/bgt-123" });
    expect(byPath["agents/old-slug.md"].slug).toBe("old-slug");
    expect(byPath["rooms/r/archives/1700000000000.summary.json"].archiveTimestamp).toBe("1700000000000");
  });

  it("inventories the union of body-only/meta-only/history-only owners, retaining approved bodies and snapshots", () => {
    const hash = "a".repeat(64);
    const retained = ["members/mem_a/persona.md", "members/mem_a/memory/persona.md",
      "members/mem_a/memory/scopes/dm/principles.md", "members/mem_a/memory/scopes/room-r/mainline.md",
      "members/mem_a/memory/scopes/topic-t/principles.md", "rooms/r/memory/room-principles.md",
      "rooms/r/memory/members/sanitized_owner/principles.md", "rooms/r/memory/members/sanitized_owner/mainline.md",
      "rooms/r/prompt-supplements/room.md", "rooms/r/prompt-supplements/members/old_owner.md", "rooms/r/mainlines/members/old_owner.md",
      `members/mem_a/history/persona/${hash}.md`, `members/mem_a/memory/scopes/dm/history/principles/${hash}.md`,
      `rooms/r/memory/history/room-principles/${hash}.md`, `rooms/r/memory/members/sanitized_owner/history/mainline/${hash}.md`];
    const retired = ["members/mem_a/memory/persona-history.jsonl", "members/mem_a/memory/scopes/dm/principles-history.jsonl",
      "members/deleted/memory/scopes/topic-lost/mainline-history.jsonl", "rooms/no-bodies/memory/principles-meta.json",
      "rooms/r/memory/principles-meta.json", "rooms/r/memory/mainline-meta.json", "rooms/r/memory/principles-history.jsonl",
      "rooms/r/memory/mainline-history.jsonl", "rooms/r/prompt-supplements/meta.json", "rooms/r/prompt-supplements/history.jsonl",
      "rooms/r/mainlines/meta.json", "rooms/r/mainlines/history.jsonl"];
    for (const path of [...retained, ...retired]) put(path, "body unchanged\r\n");
    const { entries, diagnostics } = discoverLegacyInventory(root);
    expect(diagnostics).toEqual([]);
    expect(entries.filter(e => !e.retire).map(e => e.path).sort()).toEqual(retained.sort());
    expect(entries.filter(e => e.retire).map(e => e.path).sort()).toEqual(retired.sort());
    expect(entries.find(e => e.path === "members/deleted/memory/scopes/topic-lost/mainline-history.jsonl"))
      .toMatchObject({ memberId: "deleted", scopeId: "topic:lost", layer: "mainline", documentPath: "members/deleted/memory/scopes/topic-lost/mainline.md" });
    expect(entries.find(e => e.path.endsWith("sanitized_owner/principles.md")))
      .toMatchObject({ ownerKey: "sanitized_owner", scopeId: "r", layout: "room-memory" });
    expect(entries.find(e => e.path.endsWith("sanitized_owner/principles.md"))?.memberId).toBeUndefined();
    expect(entries.find(e => e.path.endsWith("prompt-supplements/meta.json"))?.layout).toBe("copy-forward");
    expect(fs.readFileSync(join(root, retained[0]), "utf8")).toBe("body unchanged\r\n");
  });

  it("retains fired and legacy export metadata/bodies without exposing them as active facts", () => {
    const paths = ["backups/fired-old/member.json", "backups/fired-old/member.md", "backups/fired-old/persona.md",
      "backups/fired-old/memory/persona.md", "backups/fired-old/memory/scopes/dm/mainline.md",
      "backups/legacy-0.19-old/manifest.json", "backups/legacy-0.19-old/rooms/r/room.json",
      "backups/legacy-0.19-old/rooms/r/memory/members/old/principles.md", "backups/legacy-other/members/mem_a/member.json"];
    for (const path of paths) put(path);
    for (const path of ["backups/core-upgrade-1/files/config.json", "backups/incident-1/members/mem_a/member.json",
      "backups/staged/manifest.json", "backups/fired-old/sessions/2026-09-09/dm/sdk.jsonl",
      "backups/fired-old/sessions/sdk.jsonl", "backups/fired-old/skills/skill/metadata.json"]) put(path);
    const inventory = discoverLegacyInventory(root);
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.entries.map(e => e.path).sort()).toEqual(paths.sort());
    expect(inventory.entries.every(e => e.kind === "export-snapshot" && !e.retire && !e.scopeId && !e.memberId)).toBe(true);
    expect(inventory.entries.find(e => e.path.endsWith("manifest.json"))).toMatchObject({ archivePath: "backups/legacy-0.19-old", snapshotKind: "archive-manifest" });
    expect(inventory.entries.find(e => e.path === "backups/fired-old/member.md")?.snapshotKind).toBe("member-profile-mixed");
  });

  it("never follows external key references, SDK bodies, asset trees or staged files; reports unknown siblings only", () => {
    put("members/mem_a/workspaces.json", JSON.stringify({ entries: [{ keyPath: join(sandbox, "outside-secret") }] }));
    fs.writeFileSync(join(sandbox, "outside-secret"), "NEVER READ");
    const excluded = ["members/mem_a/sessions/2026-09-09/rooms/r/sdk.jsonl", "members/mem_a/sessions/2026-09-09/topics/t/sdk.jsonl",
      "members/mem_a/sessions/2026-09-09/dm/sdk.jsonl", "members/mem_a/sessions/sdk.jsonl",
      "members/mem_a/background-tasks/2026-09-09/bgt-1/sdk.jsonl", "members/mem_a/background-tasks/2026-09-09/bgt-1/task.json.tmp",
      "rooms/r/topics/t/sessions/nested/sdk.jsonl", "pi-agent/runtime/r/old/sessions/sdk.jsonl", "pi-agent/runtime/members/mem_a/dm/sessions/sdk.jsonl",
      "members/mem_a/skills/s/metadata.json", "members/mem_a/extensions/e/metadata.json", "node_modules/p/config.json",
      "memory/user/secrets.json", "memory/projects/p/notes.md", "members/mem_a/archive/notes.md", "knowledge/test.json",
      "migrations/member-sessions-v1-recovery.json", "agents/slug/import-hash/persona.md", "mcp/runtime/models.json",
      "config.json.tmp", "rooms/r/tasks.json.partial", "rooms/staged.tmp/room.json"];
    for (const path of excluded) put(path, "not valid json\n");
    const unknown = ["future.json", "members/unknown.json", "members/mem_a/extra.json", "rooms/r/extra.json", "rooms/r/models.json",
      "rooms/r/memory/future-meta.json", "members/mem_a/background-tasks/2026-09-09/bgt-1/future.json"];
    for (const path of unknown) put(path);
    vi.clearAllMocks();
    const result = discoverLegacyInventory(root);
    expect(result.entries.map(e => e.path)).toEqual(["members/mem_a/workspaces.json"]);
    expect(result.diagnostics.map(d => d.path).sort()).toEqual([...unknown, "mcp/runtime/models.json"].sort());
    expect(fs.readFileSync).not.toHaveBeenCalled();
    const visited = vi.mocked(fs.readdirSync).mock.calls.map(c => String(c[0]));
    expect(visited.some(p => p.includes("/skills") || p.includes("/extensions") || p.includes("/node_modules") || p.includes("/pi-agent") || p.includes("/memory/user"))).toBe(false);
  });

  it("ignores symlinked arbitrary allowed asset trees rather than traversing them", () => {
    fs.mkdirSync(join(root, "members/mem_a"), { recursive: true });
    for (const path of ["members/mem_a/skills", "members/mem_a/extensions", "members/mem_a/archive", "memory", "node_modules", "pi-agent", "backups/core-upgrade-1"]) {
      fs.mkdirSync(dirname(join(root, path)), { recursive: true });
      fs.symlinkSync(join(sandbox, "does-not-exist"), join(root, path));
    }
    expect(discoverLegacyInventory(root)).toEqual({ entries: [], diagnostics: [] });
  });

  it.each(["config.json", "members", "members/mem_a", "members/mem_a/ssh", "members/mem_a/ssh/id_ed25519",
    "members/mem_a/persona.md", "members/mem_a/memory", "rooms/r/agent-events", "backups/fired-x", "agents/slug.md"])
  ("rejects known-managed symlink ambiguity at %s without following even an internal target", path => {
    put("safe-target", "secret");
    fs.mkdirSync(dirname(join(root, path)), { recursive: true });
    fs.symlinkSync(join(root, "safe-target"), join(root, path));
    expect(() => discoverLegacyInventory(root)).toThrowError(new LegacySourceError("symlink-source", path));
  });

  it("requires an existing absolute nonsymlink root and rejects special/nonregular sources", () => {
    expect(() => discoverLegacyInventory("relative")).toThrow(/invalid-root/);
    expect(() => discoverLegacyInventory(join(sandbox, "missing"))).toThrow(/source-io/);
    fs.symlinkSync(root, join(sandbox, "link"));
    expect(() => discoverLegacyInventory(join(sandbox, "link"))).toThrow(/symlink-source/);
    fs.mkdirSync(join(root, "config.json"));
    expect(() => discoverLegacyInventory(root)).toThrow(/not-regular-file/);
    fs.rmdirSync(join(root, "config.json"));
    put("members", "not a directory");
    expect(() => discoverLegacyInventory(root)).toThrow(/not-directory/);
  });

  it.each(["", "../config.json", "/config.json", "a/../config.json", "./config.json", "a//b", "a/", "a\\b", "C:/config.json", "a\0b", "a\nb"])
  ("rejects traversal/noncanonical path %j", path => {
    expect(() => validateLegacyPath(path)).toThrow(/invalid-path/);
    expect(() => readLegacyJson(root, { path })).toThrow(/invalid-path/);
  });
  it("rejects duplicate source paths even with contradictory retirement flags", () => {
    expect(() => validateLegacySources([{ path: "config.json", retire: true }, { path: "config.json", retire: false }])).toThrow(/duplicate-path/);
    expect(() => validateLegacySources([{ path: "config.json", retire: true }, { path: "members/mem_a/persona.md", retire: false }])).not.toThrow();
  });
});

describe("strict startup readers", () => {
  it("reads strict JSON from the selected snapshot root; never falls back to another root", () => {
    put("config.json", '{"source":"live"}');
    const snapshot = join(sandbox, "backup/files");
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(join(snapshot, "config.json"), '{"source":"snapshot","zero":0,"nil":null}');
    expect(readLegacyJson(snapshot, { path: "config.json" })).toEqual({ source: "snapshot", zero: 0, nil: null });
    fs.unlinkSync(join(snapshot, "config.json"));
    expect(() => readLegacyJson(snapshot, { path: "config.json" })).toThrow(/source-io/);
  });
  it("redacts strict JSON parser diagnostics while retaining relative path and physical line", () => {
    put("model-credentials.json", '{\n  "token": "TOP-SECRET",\n  invalid\n}');
    let error: unknown;
    try { readLegacyJson(root, { path: "model-credentials.json" }); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "invalid-json", path: "model-credentials.json", lineNumber: 3 });
    expect(String(error)).not.toContain("TOP-SECRET");
    expect((error as Error).cause).toBeUndefined();
    put("config.json", Buffer.from([0xff]));
    expect(() => readLegacyJson(root, { path: "config.json" })).toThrow(/invalid-utf8/);
    put("config.json", '\ufeff{"ok":true}');
    expect(() => readLegacyJson(root, { path: "config.json" })).toThrow(/invalid-json/);
    put("config.json", '\nTOP-SECRET\nnot valid\n');
    try { readLegacyJson(root, { path: "config.json" }); throw new Error("accepted invalid JSON"); }
    catch (e) { expect(e).toMatchObject({ code: "invalid-json", lineNumber: 2 }); }
    put("config.json", '{\n "unfinished":\n');
    try { readLegacyJson(root, { path: "config.json" }); throw new Error("accepted partial JSON"); }
    catch (e) { expect(e).toMatchObject({ code: "invalid-json", lineNumber: 3 }); }
  });
  it("rejects forged unapproved paths, format mismatches and symlinks introduced after inventory", async () => {
    put("rooms/r/messages.jsonl", '{}\n');
    const entry = discoverLegacyInventory(root).entries[0];
    expect(() => readLegacyJson(root, { path: "rooms/r/messages.jsonl" })).toThrow(/wrong-format/);
    put("config.json");
    await expect(all("config.json")).rejects.toThrow(/wrong-format/);
    put("members/mem_a/skills/secret.json");
    expect(() => readLegacyJson(root, { path: "members/mem_a/skills/secret.json" })).toThrow(/unapproved-source/);
    await expect(all("members/mem_a/sessions/sdk.jsonl")).rejects.toThrow(/unapproved-source/);
    fs.unlinkSync(join(root, entry.path));
    fs.symlinkSync(join(root, "config.json"), join(root, entry.path));
    await expect(all(entry.path)).rejects.toThrow(/symlink-source/);
    fs.unlinkSync(join(root, entry.path));
    fs.rmdirSync(join(root, "rooms/r"));
    fs.symlinkSync(root, join(root, "rooms/r"));
    await expect(all(entry.path)).rejects.toThrow(/symlink-source/);
  });
  it("preserves source order, all nonblank event ordinals, CRLF and physical lines", async () => {
    const path = "rooms/dm:mem_a/agent-events/reused-name.jsonl";
    put(path, '\r\n {"type":"delta","ts":50}\r\n\t \n{"type":"final","ts":10,"text":"你好🌊"}\nnull\n42\n');
    const records = await all(path);
    expect(records.map(r => [r.ordinal, r.lineNumber, r.value])).toEqual([
      [1, 2, { type: "delta", ts: 50 }], [2, 4, { type: "final", ts: 10, text: "你好🌊" }], [3, 5, null], [4, 6, 42],
    ]);
    expect(records.every(r => r.path === path)).toBe(true);
  });
  it("fails at a malformed committed line without skipping, renumbering or exposing secrets", async () => {
    const path = "rooms/r/messages.jsonl";
    put(path, '\n{"ok":1}\n\n{"secret":"TOP-SECRET", broken}\n{"ok":2}\n');
    const reader = readLegacyJsonl(root, { path });
    expect((await reader.next()).value).toMatchObject({ ordinal: 1, lineNumber: 2 });
    let error: unknown;
    try { await reader.next(); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "invalid-json", path, lineNumber: 4 });
    expect(String(error)).not.toContain("TOP-SECRET");
    expect((error as Error).cause).toBeUndefined();
    expect(await reader.next()).toMatchObject({ done: true });
    const fd = vi.mocked(fs.openSync).mock.results.at(-1)!.value;
    expect(() => fs.fstatSync(fd)).toThrow();
  });
  it.each(['{"partial":"SECRET', '{"syntactically":"valid-but-not-committed"}'])
  ("does not yield an unterminated tail %j", async tail => {
    const path = "rooms/r/messages.jsonl";
    put(path, `{}\n\n${tail}`);
    const reader = readLegacyJsonl(root, { path });
    expect((await reader.next()).value).toMatchObject({ ordinal: 1, lineNumber: 1 });
    await expect(reader.next()).rejects.toMatchObject({ code: "unterminated-jsonl-line", path, lineNumber: 3 });
  });
  it("accepts empty/whitespace files and trailing blank fragments, but not invalid UTF-8", async () => {
    const path = "rooms/r/messages.jsonl";
    put(path, ""); expect(await all(path)).toEqual([]);
    put(path, "\n\t \r\n \t"); expect(await all(path)).toEqual([]);
    put(path, "{}\n \t"); expect(await all(path)).toHaveLength(1);
    put(path, Buffer.from([123, 125, 10, 255, 10]));
    await expect(all(path)).rejects.toMatchObject({ code: "invalid-utf8", lineNumber: 2 });
    put(path, '\ufeff\n');
    await expect(all(path)).rejects.toMatchObject({ code: "invalid-json", lineNumber: 1 });
  });
  it("is lazy and closes its descriptor when the consumer returns early", async () => {
    const path = "rooms/r/messages.jsonl";
    put(path, '{}\nmalformed-SECRET\n');
    const reader = readLegacyJsonl(root, { path });
    vi.clearAllMocks();
    expect(fs.openSync).not.toHaveBeenCalled();
    expect((await reader.next()).value).toMatchObject({ ordinal: 1 });
    const fd = vi.mocked(fs.openSync).mock.results.at(-1)!.value;
    expect(fs.fstatSync(fd).isFile()).toBe(true);
    await reader.return(undefined);
    expect(() => fs.fstatSync(fd)).toThrow();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
  it("streams sizeable input and a multibyte multi-buffer record in exact order without whole-file reads", async () => {
    const path = "rooms/r/topics/t/agent-events/old-owner.jsonl";
    const full = put(path, "");
    const fd = fs.openSync(full, "w");
    const count = 20000;
    const text = "界🌊".repeat(600);
    const huge = "x".repeat(65520) + "🌊界".repeat(40000);
    try {
      fs.writeSync(fd, JSON.stringify({ huge }) + "\n\n");
      for (let i = 0; i < count; i++) fs.writeSync(fd, JSON.stringify({ i, text }) + "\n");
    } finally { fs.closeSync(fd); }
    expect(fs.statSync(full).size).toBeGreaterThan(80_000_000);
    vi.clearAllMocks();
    let seen = 0;
    for await (const record of readLegacyJsonl(root, { path })) {
      expect(record.ordinal).toBe(seen + 1);
      if (!seen) expect(record.value).toEqual({ huge });
      else {
        expect(record.value).toEqual({ i: seen - 1, text });
        expect(record.lineNumber).toBe(seen + 2);
      }
      seen++;
    }
    expect(seen).toBe(count + 1);
    expect(fs.readFileSync).not.toHaveBeenCalled();
  }, 20000);
});
