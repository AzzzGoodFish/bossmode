import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("retired member storage boundary", () => {
  it("has no live member-store module/import and only the historical room converter can read members.json", () => {
    expect(existsSync("src/workforce/member-store.ts")).toBe(false);
    const readers: string[] = [];
    for (const path of sources("src")) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/(?:from\s*|import\s*\()["'][^"']*member-store(?:\.js)?["']/);
      if (/["'`]members\.json["'`]/.test(text)) readers.push(relative("src", path));
    }
    expect(readers.sort()).toEqual(["chat/migrations/room-member-migration.ts"]);
  });
});
