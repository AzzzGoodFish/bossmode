import { expect, it } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import ts from "typescript";
import { publishAssetDurably } from "../../src/files/io.js";

it("SIGKILL during asset copying leaves only a temporary file and ordinary retry succeeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "bm-upgrade-kill-"));
  const source = join(root, "source.md"), destination = join(root, "members/id/persona.md");
  const helper = join(root, "helper.mjs"), script = join(root, "child.mjs");
  writeFileSync(source, "complete original bytes\r\n");
  const code = readFileSync(new URL("../../src/files/io.ts", import.meta.url), "utf8");
  writeFileSync(helper, ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText);
  writeFileSync(script, `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
fs.copyFileSync = (_source, target) => {
  fs.writeFileSync(target, 'partial');
  process.send('partial', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
};
syncBuiltinESMExports();
const {publishAssetDurably} = await import(${JSON.stringify(helper)});
publishAssetDurably(${JSON.stringify(source)},${JSON.stringify(destination)});
`);
  const child = fork(script, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, HOME: root, BOSSMODE_DIR: join(root, "data") } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("copy barrier timeout")), 5000);
      child.once("message", () => { clearTimeout(timer); resolve(); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("child exited before copy barrier")); });
    });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(dirname(destination))).toHaveLength(1);
    publishAssetDurably(source, destination);
    expect(readFileSync(destination, "utf8")).toBe("complete original bytes\r\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
