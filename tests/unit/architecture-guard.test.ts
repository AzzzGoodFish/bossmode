import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const script = resolve("scripts/check-architecture.mjs");
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(files: Record<string, string>, target = Object.keys(files)) {
  const dir = mkdtempSync(join(tmpdir(), "architecture-guard-")); fixtures.push(dir);
  const write = (path: string, content: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), content); };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const policy = { baselineRef: "fixture", files: target, limits: { files: 99, lines: 17440, normalizedLines: 17150 } };
  write("scripts/architecture-target.json", JSON.stringify(policy));
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, "--root", dir, ...args], { encoding: "utf8" });
    if (result.error) throw result.error;
    return { code: result.status, text: result.stdout + result.stderr };
  };
  expect(run("--init").code).toBe(0);
  return { dir, write, run, policy, baseline: () => readFileSync(join(dir, "scripts/architecture-baseline.json"), "utf8") };
}
const clean = { "src/kernel/ids.ts": "export const id = 'id';\n", "src/member/identity.ts": "export const member = 1;\n" };

describe("target architecture guard", () => {
  it("accepts a complete, small, dependency-clean target and never overwrites its baseline", () => {
    const f = fixture(clean);
    expect(f.run().code).toBe(0);
    expect(f.run("--final").text).toContain("Dependency architecture accepted");
    expect(f.run("--final").code).toBe(0);
    expect(f.run("--init").code).toBe(1);
  });

  it("reports target-tree drift without treating file-count differences as an architecture failure", () => {
    const f = fixture(clean);
    f.write("src/member/new-wrapper.ts", "export const wrapper = 1;");
    f.write("src/member/runtime-rules.json", "{}");
    const result = f.run("--final");
    expect(result.code).toBe(0);
    expect(result.text).toContain("Target-tree differences:");
    expect(result.text).toContain("size/tree metrics are informational");
  });

  it.each([
    "import { chat } from '../chat/conversations.js'; export const member = chat;",
    "export { chat } from '../chat/conversations.js';",
    "const c = await import('../chat/conversations.js'); export const member = c.chat;",
    "export type C = typeof import('../chat/conversations.js');",
    "const c = require('../chat/conversations.js'); export const member = c.chat;",
  ])("checks static, re-export, dynamic, type and require edges: %s", source => {
    const f = fixture({ ...clean, "src/chat/conversations.ts": "export const chat = 1;" });
    f.write("src/member/identity.ts", source);
    const result = f.run();
    expect(result.code).toBe(1);
    expect(result.text).toContain("dependency|src/member/identity.ts|src/chat/conversations.ts");
  });

  it("does not exempt a dependency violation when its source file is renamed", () => {
    const f = fixture({ "src/member/old.ts": "import '../chat/conversations.js';", "src/chat/conversations.ts": "export {};" },
      ["src/member/identity.ts", "src/chat/conversations.ts"]);
    expect(f.run().code).toBe(0);
    rmSync(join(f.dir, "src/member/old.ts"));
    f.write("src/member/identity.ts", "import '../chat/conversations.js';");
    expect(f.run().text).toContain("dependency|src/member/identity.ts|src/chat/conversations.ts: 0 -> 1");
    expect(f.run().code).toBe(1);
  });

  it("checks SDK type imports but ignores SDK package names in comments", () => {
    const f = fixture({ ...clean, "src/agent/runtime/pi.ts": "export {};" });
    f.write("src/agent/runtime/pi.ts", "import type { Model } from '@earendil-works/pi-ai';");
    f.write("src/member/identity.ts", "// @earendil-works/pi-ai\nexport const member = 1;");
    expect(f.run().code).toBe(0);
    f.write("src/member/identity.ts", "import type { Model } from '@earendil-works/pi-ai';");
    expect(f.run().text).toContain("sdk|src/member/identity.ts|@earendil-works/pi-ai");
    expect(f.run().code).toBe(1);
  });

  it("rejects new file cycles even inside an otherwise permitted module", () => {
    const f = fixture({ "src/kernel/ids.ts": "export const id = 1;", "src/kernel/json.ts": "import './ids.js';" });
    f.write("src/kernel/ids.ts", "import './json.js'; export const id = 1;");
    expect(f.run().code).toBe(1);
    expect(f.run().text).toContain("cycle|");
  });

  it("cannot ratchet a new violation into the accepted baseline", () => {
    const f = fixture({ ...clean, "src/chat/conversations.ts": "export {};" });
    const before = f.baseline();
    f.write("src/member/identity.ts", "import '../chat/conversations.js';");
    expect(f.run("--ratchet").code).toBe(1);
    expect(f.baseline()).toBe(before);
  });

  it("reports target leaves and normalized size as informational metrics", () => {
    const f = fixture(clean, [...Object.keys(clean), "src/kernel/json.ts"]);
    expect(f.run("--final").code).toBe(0);
    f.write("src/kernel/json.ts", "export const object = {a: 1,b: 2,c: 3,d: 4,e: 5};");
    f.policy.limits.normalizedLines = 2;
    f.write("scripts/architecture-target.json", JSON.stringify(f.policy));
    const result = f.run("--final");
    expect(result.code).toBe(0);
    expect(result.text).toContain("normalized lines");
    expect(result.text).toContain("size/tree metrics are informational");
  });

  it("refuses source symlinks and unresolvable module paths", () => {
    const f = fixture(clean);
    f.write("src/member/identity.ts", "import './missing.js';");
    expect(f.run().text).toContain("unresolved|src/member/identity.ts|./missing.js");
    symlinkSync(join(f.dir, "src/kernel/ids.ts"), join(f.dir, "src/member/hidden.ts"));
    expect(f.run().text).toContain("Source symlinks are not allowed");
    expect(f.run().code).toBe(1);
  });
});
