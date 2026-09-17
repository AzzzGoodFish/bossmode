import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { ensureMemberSshKeyPair, prepareMemberSshCredential, readSshCredential } from "../../src/member/workspaces.js";

let fixture: ReturnType<typeof coreFixture>;
let bin: string;
beforeEach(() => {
  fixture = coreFixture();
  bin = join(fixture.root, "keygen-bin");
  mkdirSync(bin, { recursive: true });
  vi.stubEnv("PATH", bin + ":" + process.env.PATH);
});
afterEach(() => { vi.unstubAllEnvs(); fixture.close(); });

it("keeps a competing process's committed SSH credential instead of replacing it with newly generated material", () => {
  const probe = join(fixture.root, "keygen-path");
  writeFileSync(join(bin, "ssh-keygen"), `#!${process.execPath}
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const key = process.argv[process.argv.indexOf("-f") + 1];
fs.writeFileSync(key, "candidate-private");
fs.writeFileSync(key + ".pub", "candidate-public");
fs.writeFileSync(${JSON.stringify(probe)}, key);
const db = new DatabaseSync(${JSON.stringify(fixture.db.path)});
db.prepare("INSERT INTO ssh_credentials VALUES (?,?,?,NULL)").run("member", "winner-private", "winner-public");
db.close();
`, { mode: 0o700 });
  expect(ensureMemberSshKeyPair("member")).toBe("winner-public");
  expect(readSshCredential("member")).toEqual({ privateKey: "winner-private", publicKey: "winner-public" });
  expect(existsSync(dirname(readFileSync(probe, "utf8")))).toBe(false);
});

it("keeps optional key creation nullable while required birth preparation fails loudly", () => {
  writeFileSync(join(bin, "ssh-keygen"), `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o700 });
  expect(ensureMemberSshKeyPair("optional")).toBeNull();
  expect(readSshCredential("optional")).toBeNull();
  expect(() => prepareMemberSshCredential("required")).toThrow();
  expect(readSshCredential("required")).toBeNull();
});
