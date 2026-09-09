import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
const trace = vi.hoisted(() => ({ paths: new Map<number, string>(), syncs: [] as string[], chmods: [] as string[], failCopy: false, failLeasePermission: false, failSyncPath: undefined as string | undefined, failAfterLink: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    chmodSync: (...args: Parameters<typeof fs.chmodSync>) => {
      trace.chmods.push(String(args[0]));
      if (trace.failLeasePermission && String(args[0]).endsWith("lease.sqlite")) throw new Error("injected permission failure");
      return fs.chmodSync(...args);
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => { const fd = fs.openSync(...args); trace.paths.set(fd, String(args[0])); return fd; },
    fsyncSync: (fd: number) => {
      const path = trace.paths.get(fd)!; trace.syncs.push(path);
      if (path === trace.failSyncPath) throw new Error("injected directory sync failure");
      fs.fsyncSync(fd);
    },
    linkSync: (...args: Parameters<typeof fs.linkSync>) => {
      fs.linkSync(...args);
      if (trace.failAfterLink) trace.failSyncPath = String(args[1]).slice(0, String(args[1]).lastIndexOf("/"));
    },
    copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
      if (trace.failCopy) { trace.failCopy = false; fs.writeFileSync(args[1], "partial"); throw new Error("interrupted copy"); }
      return fs.copyFileSync(...args);
    },
  };
});
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, readlinkSync } from "node:fs";
import { prepareStorageUpgrade } from "../../src/storage/upgrade-runner.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { copyDurably, publishAssetDurably, ensurePrivateDirectory } from "../../src/storage/upgrade-files.js";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bm-upgrade-files-")); trace.syncs.length = 0; trace.chmods.length = 0; trace.failCopy = false; trace.failLeasePermission = false; trace.failSyncPath = undefined; trace.failAfterLink = false; });
afterEach(() => rmSync(root, { recursive: true, force: true }));
it("fsyncs every newly created directory and the parent entry that names it", () => {
  const source = join(root, "source"); writeFileSync(source, "body");
  const destination = join(root, "backups/generation/files/members/id/meta.json");
  copyDurably(source, destination);
  let directory = dirname(destination);
  while (directory !== root) {
    expect(trace.syncs).toContain(directory);
    expect(trace.syncs).toContain(dirname(directory));
    directory = dirname(directory);
  }
});
it("does not publish partial copied assets, and retries without replacing genuine content", () => {
  const source = join(root, "source"); writeFileSync(source, "complete content");
  const destination = join(root, "members/id/persona.md");
  trace.failCopy = true;
  expect(() => publishAssetDurably(source, destination)).toThrow("interrupted copy");
  expect(existsSync(destination)).toBe(false);
  expect(readdirSync(dirname(destination))).toEqual([]);
  publishAssetDurably(source, destination);
  expect(readFileSync(destination, "utf8")).toBe("complete content");
  writeFileSync(destination, "user content");
  expect(() => publishAssetDurably(source, destination)).toThrow(/EEXIST/);
  expect(readFileSync(destination, "utf8")).toBe("user content");
});
it("does not chmod existing ancestors when creating a private chain", () => {
  ensurePrivateDirectory(join(root, "one/two/three"));
  expect(trace.syncs).toContain(root);
  expect(trace.chmods).toEqual([join(root, "one/two/three")]);
});
it.skipIf(process.platform !== "linux")("closes the native lease handle if permission setup fails", async () => {
  trace.failLeasePermission = true;
  await expect(prepareStorageUpgrade({root, formatVersion:1, migrations:[baseStorageMigration], collectLegacySources:async()=>[], importData:async()=>{}, validate:async()=>{}})).rejects.toThrow("lease");
  const openPaths = readdirSync("/proc/self/fd").flatMap(fd => { try { return [readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; } });
  expect(openPaths).not.toContain(join(root, "upgrades/lease.sqlite"));
});

it("re-syncs an existing directory left by a failed parent-entry sync", () => {
  const destination = join(root, "one/two");
  trace.failSyncPath = root;
  expect(() => ensurePrivateDirectory(destination)).toThrow("directory sync failure");
  trace.failSyncPath = undefined; trace.syncs.length = 0;
  ensurePrivateDirectory(destination);
  expect(trace.syncs).toContain(root);
});
it("re-syncs matching retry assets before allowing the authority marker to commit", async () => {
  const destination = "members/mem_one/history/revision.md";
  const options = {root,formatVersion:1,migrations:[baseStorageMigration],collectLegacySources:async()=>[],importData:async(ctx:any)=>ctx.stageAsset(destination,Buffer.from("preserved")),validate:async()=>{}};
  trace.failAfterLink = true;
  await expect(prepareStorageUpgrade(options)).rejects.toThrow("directory sync failure");
  expect(existsSync(join(root,destination))).toBe(true);
  trace.failAfterLink = false; trace.failSyncPath = undefined; trace.syncs.length = 0;
  const result = await prepareStorageUpgrade({...options,checkpoint:phase=>{if(phase==="validated")expect(trace.syncs).toContain(dirname(join(root,destination)));}});
  result.db.close();
});
