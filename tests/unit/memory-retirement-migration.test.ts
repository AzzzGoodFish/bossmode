import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { archiveLegacySharedMemory, cleanupMemberMemoryScopes } from "../../src/storage/memory-retirement-migration.js";

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

  it("is non-blocking when nothing matches", () => {
    expect(() => archiveLegacySharedMemory(root, fixture.db)).not.toThrow();
    expect(() => cleanupMemberMemoryScopes(root, fixture.db)).not.toThrow();
  });
});
