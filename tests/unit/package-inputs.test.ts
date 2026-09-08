import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts", "check-package-inputs.mjs");
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("package input guard", () => {
  it("blocks an empty adapter checkout and accepts the required pinned files", () => {
    root = mkdtempSync(join(tmpdir(), "bossmode-package-inputs-"));
    let result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("git submodule update --init vendor/pi-mcp-adapter");

    const adapter = join(root, "vendor", "pi-mcp-adapter");
    mkdirSync(adapter, { recursive: true });
    writeFileSync(join(adapter, "index.ts"), "export {};\n");
    writeFileSync(join(adapter, "LICENSE"), "test\n");
    result = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
