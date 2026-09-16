/**
 * Batch 7 P1 (spec-batch7-workspace-shell-impl-v1 §6): workspace registry,
 * workspace-aware file tools (local + mocked ssh), prompt line, assets API.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;
beforeEach(async () => {
  dir = process.env.BOSSMODE_DIR!;
  mkdirSync(join(dir, "members"), { recursive: true });
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
  const { importMemberRecord } = await import("../../src/member/member-registry.js");
  importMemberRecord({ id: MEMBER, name: "wsbot", agentTemplate: "general",
    unifiedModel: true, unifiedExtensions: true, scopeOverrides: {},
    global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
    createdAt: 1, updatedAt: 1 });
});
afterEach(() => {
  fixture.close();
});

const MEMBER = "mem_ws_a";

function seedMemberDir() {
  mkdirSync(join(dir, "members", MEMBER), { recursive: true });
}

describe("workspace registry", () => {
  it("original is synthesized, immune, and default-active without a file", async () => {
    seedMemberDir();
    const reg = await import("../../src/member/workspaces/workspace-registry.js");
    const list = reg.listWorkspaces(MEMBER);
    expect(list.active).toBe("original");
    expect(list.workspaces).toHaveLength(1);
    expect(list.workspaces[0].kind).toBe("original");
    expect(list.workspaces[0].root).toBe(join(dir, "members", MEMBER));
    expect(reg.removeWorkspace(MEMBER, "original").ok).toBe(false);
    expect(reg.createWorkspace(MEMBER, { id: "original", kind: "ssh", host: "h", user: "u" }).ok).toBe(false);
  });

  it("ssh lifecycle: create → active switch → remove falls back to original", async () => {
    seedMemberDir();
    const reg = await import("../../src/member/workspaces/workspace-registry.js");
    const created = reg.createWorkspace(MEMBER, { id: "web1", kind: "ssh", host: "srv.example", user: "deploy", root: "/srv/app" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.workspace.port).toBe(22);
    expect(created.workspace.keyPath).toBe(join(dir, "members", MEMBER, "ssh", "id_ed25519"));

    const used = reg.useWorkspace(MEMBER, "web1");
    expect(used.ok && used.active).toBe("web1");
    expect(reg.activeWorkspaceRoot(MEMBER)).toBe("/srv/app");

    expect(reg.removeWorkspace(MEMBER, "web1").ok).toBe(true);
    const after = reg.listWorkspaces(MEMBER);
    expect(after.active).toBe("original");
    expect(after.workspaces).toHaveLength(1);
  });

  it("invalid ids and duplicates are rejected", async () => {
    seedMemberDir();
    const reg = await import("../../src/member/workspaces/workspace-registry.js");
    expect(reg.createWorkspace(MEMBER, { id: "bad id!", kind: "ssh", host: "h", user: "u" }).ok).toBe(false);
    expect(reg.createWorkspace(MEMBER, { id: "web1", kind: "ssh", host: "h", user: "u" }).ok).toBe(true);
    expect(reg.createWorkspace(MEMBER, { id: "web1", kind: "ssh", host: "h", user: "u" }).ok).toBe(false);
  });
});

describe("file tools (original workspace)", () => {
  it("relative paths resolve against the member dir; write→read→edit round-trip", async () => {
    seedMemberDir();
    const ft = await import("../../src/agent/tools/file-tools.js");
    const w = await ft.workspaceWriteTool(MEMBER, { path: "notes/a.txt", content: "line1\nline2\nline3" });
    expect(w.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Wrote") });
    expect(existsSync(join(dir, "members", MEMBER, "notes", "a.txt"))).toBe(true);

    const r = await ft.workspaceReadTool(MEMBER, { path: "notes/a.txt", offset: 2, limit: 1 });
    expect((r.content[0] as any).text.startsWith("line2")).toBe(true);

    const e = await ft.workspaceEditTool(MEMBER, { path: "notes/a.txt", edits: [{ oldText: "line2", newText: "LINE-TWO" }] });
    expect((e.content[0] as any).text).toContain("Applied 1 edit");
    expect(readFileSync(join(dir, "members", MEMBER, "notes", "a.txt"), "utf-8")).toContain("LINE-TWO");

    // absolute paths stay absolute (original = whole machine)
    const abs = await ft.workspaceWriteTool(MEMBER, { path: join(dir, "abs-test.txt"), content: "x" });
    expect((abs.content[0] as any).text).toContain("Wrote");
    expect(existsSync(join(dir, "abs-test.txt"))).toBe(true);

    // edit honesty: not-found and ambiguous matches fail with clear text
    const miss = await ft.workspaceEditTool(MEMBER, { path: "notes/a.txt", edits: [{ oldText: "nope", newText: "x" }] });
    expect((miss.content[0] as any).text).toContain("oldText not found");
  });
});

describe("file tools (ssh workspace, mocked ssh2)", () => {
  it("read/write route through sftp with workspace-relative roots", async () => {
    seedMemberDir();
    const remoteFiles = new Map<string, string>();
    const sftp = {
      createReadStream: (path: string) => {
        const ok = remoteFiles.has(path);
        const data = ok ? Buffer.from(remoteFiles.get(path)!) : null;
        const listeners: Record<string, Function[]> = {};
        const finish = () => {
          for (const fn of listeners.data ?? []) if (data) fn(data);
          if (ok) for (const fn of listeners.end ?? []) fn();
          else for (const fn of listeners.error ?? []) fn(new Error("No such file"));
        };
        return {
          on(ev: string, fn: Function) {
            (listeners[ev] ??= []).push(fn);
            if (ev === "error") setImmediate(finish);
            return this;
          },
        };
      },
      writeFile: (path: string, data: Buffer, cb: Function) => { remoteFiles.set(path, data.toString()); cb(undefined); },
      mkdir: (_p: string, cb: Function) => cb(undefined),
    };
    vi.doMock("ssh2", () => ({
      Client: class {
        handlers: Record<string, Function[]> = {};
        on(ev: string, fn: Function) { (this.handlers[ev] ??= []).push(fn); return this; }
        connect() { setImmediate(() => this.handlers.ready?.[0]?.()); }
        sftp(cb: Function) { cb(undefined, sftp); }
        end() {}
      },
    }));
    try {
      const reg = await import("../../src/member/workspaces/workspace-registry.js");
      const created = reg.createWorkspace(MEMBER, { id: "web1", kind: "ssh", host: "h", user: "u", root: "/srv/app" });
      expect(created.ok).toBe(true);
      reg.useWorkspace(MEMBER, "web1");

      const ft = await import("../../src/agent/tools/file-tools.js");
      const w = await ft.workspaceWriteTool(MEMBER, { path: "conf/app.conf", content: "mode=prod\n" });
      expect((w.content[0] as any).text).toContain("ssh:web1");
      expect(remoteFiles.get("/srv/app/conf/app.conf")).toBe("mode=prod\n");

      const r = await ft.workspaceReadTool(MEMBER, { path: "conf/app.conf" });
      expect((r.content[0] as any).text).toContain("mode=prod");

      const e = await ft.workspaceEditTool(MEMBER, { path: "conf/app.conf", edits: [{ oldText: "prod", newText: "dev" }] });
      expect((e.content[0] as any).text).toContain("Applied 1 edit");
      expect(remoteFiles.get("/srv/app/conf/app.conf")).toBe("mode=dev\n");
    } finally {
      vi.doUnmock("ssh2");
      vi.resetModules();
    }
  });
});

describe("Workspace prompt chapter", () => {
  it("compile carries the Workspace chapter (per-chat current-workspace line retired with prompt v2)", async () => {
    seedMemberDir();
    const { compileMemberPrompt } = await import("../../src/agent/prompt/prompt-compiler.js");
    const compiled = compileMemberPrompt({ memberId: MEMBER, memberName: "wsbot" });
    expect(compiled.fullPrompt).toContain("## Workspace");
    expect(compiled.fullPrompt).toContain("workspace_list");
    expect(compiled.envPrompt).not.toContain("Current workspace:");
  });
});

describe("ssh public key regression (qa rc.16 ③)", () => {
  it("ssh-keygen.ts contains no require() — the package is ESM (source-level guard)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../src/member/workspaces/ssh-keygen.ts"),
      "utf-8",
    );
    // The rc.15 bug: require() in ESM throws, the catch swallowed it, and the
    // public key read as null forever — invisible to vitest (CJS compat) and
    // only fatal in package form. Source-level check is the unit-test net.
    expect(src.includes("require(")).toBe(false);
  });
});

describe("ssh key backfill (batch 7 §6, pm ruling)", () => {
  it("startup backfill generates pairs for legacy members, idempotently", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const { memberSshKeyPath, readMemberSshPublicKey } = await import("../../src/member/workspaces/ssh-keygen.js");
    const { SshCredentialsRepository } = await import("../../src/data/repositories/workspace-settings.js");
    const { backfillMemberSshKeys } = await import("../../src/member/migrations/member-assets-migration.js");
    // Import a pre-key member rather than deleting current authoritative credentials.
    const legacy = reg.importMemberRecord({ id: "mem_legacy", name: "legacybot", agentTemplate: "general",
      unifiedModel: true, unifiedExtensions: true, scopeOverrides: {},
      global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
      createdAt: 1, updatedAt: 1 });
    const credentials = new SshCredentialsRepository(fixture.db);
    expect(credentials.read(legacy.id)).toBeNull();
    const first = backfillMemberSshKeys();
    expect(first.generated).toContain("legacybot");
    expect(existsSync(memberSshKeyPath(legacy.id))).toBe(false);
    const key = credentials.read(legacy.id)!;
    expect(key.privateKey).toContain("PRIVATE KEY");
    const pub = readMemberSshPublicKey(legacy.id);
    expect(pub).toMatch(/^ssh-ed25519 /);

    // Credential material remains stable on a repeat.
    backfillMemberSshKeys();
    expect(credentials.read(legacy.id)).toEqual(key);
  });

  // SQL credentials are authoritative even when legacy key files do not exist.
  it("backfill reports existing SQL credentials as skipped on rerun", async () => {
    const { backfillMemberSshKeys } = await import("../../src/member/migrations/member-assets-migration.js");
    backfillMemberSshKeys();
    expect(backfillMemberSshKeys()).toEqual({ generated: [], skipped: 1 });
  });
});
