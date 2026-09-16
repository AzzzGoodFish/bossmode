import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { archiveLegacySharedMemory, cleanupMemberMemoryScopes } from "../../src/app/upgrade/retirements.js";

let fixture: ReturnType<typeof coreFixture>;
let root: string;
beforeEach(() => { fixture = coreFixture(); root = fixture.root; });
afterEach(() => fixture.close());

function file(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

describe("memory retirement migration (④ A/B)", () => {
  it("moves legacy shared memory into the global archive and is idempotent", () => {
    file(join(root, "memory", "user", "who.md"), "user note");
    file(join(root, "memory", "projects", "botmode", "overview.md"), "project note");

    archiveLegacySharedMemory(root, fixture.db);

    expect(readFileSync(join(root, "archive", "memory", "user", "who.md"), "utf-8")).toBe("user note");
    expect(readFileSync(join(root, "archive", "memory", "projects", "botmode", "overview.md"), "utf-8")).toBe("project note");
    expect(existsSync(join(root, "memory"))).toBe(false); // parents tidied

    const before = statSync(join(root, "archive", "memory", "user", "who.md")).mtimeMs;
    archiveLegacySharedMemory(root, fixture.db); // flag → no-op
    expect(statSync(join(root, "archive", "memory", "user", "who.md")).mtimeMs).toBe(before);
    expect(readFileSync(join(root, "archive", "memory", "user", "who.md"), "utf-8")).toBe("user note");
  });

  it("never merges: an existing archive target leaves the source in place", () => {
    file(join(root, "memory", "user", "new.md"), "new");
    file(join(root, "archive", "memory", "user", "old.md"), "old");

    archiveLegacySharedMemory(root, fixture.db);

    expect(readFileSync(join(root, "memory", "user", "new.md"), "utf-8")).toBe("new"); // left for a human
    expect(existsSync(join(root, "archive", "memory", "user", "old.md"))).toBe(true);
    expect(existsSync(join(root, "archive", "memory", "user", "new.md"))).toBe(false); // no merge
  });

  it("removes empty shells without archiving anything", () => {
    mkdirSync(join(root, "memory", "user"), { recursive: true });
    mkdirSync(join(root, "memory", "projects"), { recursive: true });

    archiveLegacySharedMemory(root, fixture.db);

    expect(existsSync(join(root, "memory"))).toBe(false);
    expect(existsSync(join(root, "archive", "memory"))).toBe(false);
  });

  it("folds member memory/scopes files into the member memory root", () => {
    file(join(root, "members", "mem_x", "memory", "scopes", "room-a", "mainline.md"), "mainline body");
    file(join(root, "members", "mem_x", "memory", "scopes", "room-a", "principles.md"), "principles body");
    mkdirSync(join(root, "members", "mem_y", "memory", "scopes"), { recursive: true });

    cleanupMemberMemoryScopes(root, fixture.db);

    expect(readFileSync(join(root, "members", "mem_x", "memory", "scopes-room-a-mainline.md"), "utf-8")).toBe("mainline body");
    expect(readFileSync(join(root, "members", "mem_x", "memory", "scopes-room-a-principles.md"), "utf-8")).toBe("principles body");
    expect(existsSync(join(root, "members", "mem_x", "memory", "scopes"))).toBe(false);
    expect(existsSync(join(root, "members", "mem_y", "memory", "scopes"))).toBe(false);

    cleanupMemberMemoryScopes(root, fixture.db); // idempotent
    expect(existsSync(join(root, "members", "mem_x", "memory", "scopes-room-a-mainline.md"))).toBe(true);
  });

  it("repoints registry and history rows to the folded files", () => {
    file(join(root, "members", "mem_x", "memory", "scopes", "room-a", "mainline.md"), "mainline body");
    file(join(root, "members", "mem_x", "memory", "scopes", "room-a", "history", "mainline", "s1.md"), "snap");
    fixture.db.run("INSERT INTO memory_documents(path,layer,member_id,scope_id,revision,content_hash,content_length) VALUES(?,?,?,?,?,?,?)",
      "members/mem_x/memory/scopes/room-a/mainline.md", "mainline", "mem_x", null, 1, "h", 1);
    fixture.db.run("INSERT INTO memory_document_history(document_path,ordinal,revision,scope_id,ts,actor_type,actor_member_id,actor_name,operation,reason,content_hash,content_length,snapshot_path,snapshot_hash,snapshot_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "members/mem_x/memory/scopes/room-a/mainline.md", 1, 1, null, 1, "member", "mem_x", "X", "update", "test", "h", 1,
      "members/mem_x/memory/scopes/room-a/history/mainline/s1.md", "h", 1);

    cleanupMemberMemoryScopes(root, fixture.db);

    expect(fixture.db.get<{ path: string }>("SELECT path FROM memory_documents")!.path).toBe("members/mem_x/memory/scopes-room-a-mainline.md");
    const history = fixture.db.get<{ document_path: string; snapshot_path: string }>("SELECT document_path,snapshot_path FROM memory_document_history")!;
    expect(history.document_path).toBe("members/mem_x/memory/scopes-room-a-mainline.md");
    expect(history.snapshot_path).toBe("members/mem_x/memory/scopes-room-a-history-mainline-s1.md");
    expect(existsSync(join(root, "members", "mem_x", "memory", "scopes-room-a-history-mainline-s1.md"))).toBe(true);

    cleanupMemberMemoryScopes(root, fixture.db); // idempotent
    expect(fixture.db.get<{ path: string }>("SELECT path FROM memory_documents")!.path).toBe("members/mem_x/memory/scopes-room-a-mainline.md");
  });

  it("reconciles rows even when the fold flag was already set (earlier build)", () => {
    // The fold ran and set its flag, but rows still point at the moved-away source.
    fixture.db.run("INSERT OR REPLACE INTO storage_meta(key,value) VALUES(?,?)", "core-member-memory-scopes-v1", JSON.stringify({ foldedFiles: 1 }));
    file(join(root, "members", "mem_x", "memory", "scopes-room-a-mainline.md"), "body");
    fixture.db.run("INSERT INTO memory_documents(path,layer,member_id,scope_id,revision,content_hash,content_length) VALUES(?,?,?,?,?,?,?)",
      "members/mem_x/memory/scopes/room-a/mainline.md", "mainline", "mem_x", null, 1, "h", 1);

    cleanupMemberMemoryScopes(root, fixture.db);

    expect(fixture.db.get<{ path: string }>("SELECT path FROM memory_documents")!.path).toBe("members/mem_x/memory/scopes-room-a-mainline.md");
  });

  it("is non-blocking when nothing matches", () => {
    expect(() => archiveLegacySharedMemory(root, fixture.db)).not.toThrow();
    expect(() => cleanupMemberMemoryScopes(root, fixture.db)).not.toThrow();
  });
});
