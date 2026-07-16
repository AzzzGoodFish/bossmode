import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

let tempDir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tempDir,
}));

describe("member-credential-binding-v1 migration", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "bossmode-member-credential-binding-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeRoom(roomId: string, roomMembers: Array<Record<string, unknown>>) {
    const dir = join(tempDir, "rooms", roomId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "room.json"), JSON.stringify({
      id: roomId,
      name: roomId,
      cwd: "/tmp",
      members: roomMembers.map((m) => m.name),
      roomMembers,
      createdAt: 1,
    }, null, 2));
  }

  function writeGlobalMembers(members: Array<Record<string, unknown>>) {
    writeFileSync(join(tempDir, "members.json"), JSON.stringify(members, null, 2));
  }

  it("clears a fish-shape legacy member (bare model, no credential) to Unconfigured and snapshots before writing", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeRoom("room-a", [
      { id: "rm_general", roomId: "room-a", name: "general", sourceAgent: "general", config: { model: "claude-sonnet-4-6" }, createdAt: 1, updatedAt: 1 },
    ]);

    const { runMemberCredentialBindingMigration } = await import("../../src/workspace/member-credential-binding-migration.js");
    runMemberCredentialBindingMigration();

    const room = JSON.parse(readFileSync(join(tempDir, "rooms", "room-a", "room.json"), "utf-8"));
    expect(room.roomMembers[0].config).toBeUndefined();

    const snapshotDir = join(tempDir, "pi-agent", "runtime", ".migration-snapshots");
    expect(existsSync(snapshotDir)).toBe(true);
    const snapshots = readdirSync(snapshotDir).filter((f) => f.includes("room-room-a"));
    expect(snapshots.length).toBeGreaterThan(0);
    const snapshotted = JSON.parse(readFileSync(join(snapshotDir, snapshots[0]), "utf-8"));
    expect(snapshotted.roomMembers[0].config).toEqual({ model: "claude-sonnet-4-6" });
  });

  it("leaves an already correctly bound member untouched", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeRoom("room-b", [
      { id: "rm_architect", roomId: "room-b", name: "architect", sourceAgent: "architect", config: { model: "moonshotai/kimi-k2.7-code", credentialId: "cred-x" }, createdAt: 1, updatedAt: 1 },
    ]);

    const { runMemberCredentialBindingMigration } = await import("../../src/workspace/member-credential-binding-migration.js");
    runMemberCredentialBindingMigration();

    const room = JSON.parse(readFileSync(join(tempDir, "rooms", "room-b", "room.json"), "utf-8"));
    expect(room.roomMembers[0].config).toEqual({ model: "moonshotai/kimi-k2.7-code", credentialId: "cred-x" });
  });

  it("leaves an unconfigured member (no model at all) untouched", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeRoom("room-c", [
      { id: "rm_qa", roomId: "room-c", name: "qa", sourceAgent: "qa", createdAt: 1, updatedAt: 1 },
    ]);

    const { runMemberCredentialBindingMigration } = await import("../../src/workspace/member-credential-binding-migration.js");
    runMemberCredentialBindingMigration();

    const room = JSON.parse(readFileSync(join(tempDir, "rooms", "room-c", "room.json"), "utf-8"));
    expect(room.roomMembers[0].config).toBeUndefined();
  });

  it("clears the legacy global members.json store the same way", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeGlobalMembers([
      { id: "developer", name: "developer", type: "agent", agent: "developer", model: "claude-sonnet-4-6", thinkingLevel: "off" },
      { id: "pm", name: "pm", type: "agent", agent: "pm", model: "anthropic/claude-opus-4-6", credentialId: "cred-a", thinkingLevel: "off" },
    ]);

    const { runMemberCredentialBindingMigration } = await import("../../src/workspace/member-credential-binding-migration.js");
    runMemberCredentialBindingMigration();

    const members = JSON.parse(readFileSync(join(tempDir, "members.json"), "utf-8"));
    const developer = members.find((m: any) => m.id === "developer");
    const pm = members.find((m: any) => m.id === "pm");
    expect(developer.model).toBeUndefined();
    expect(developer.credentialId).toBeUndefined();
    expect(pm.model).toBe("anthropic/claude-opus-4-6");
    expect(pm.credentialId).toBe("cred-a");
  });

  it("clears real historical legacy global data injected after an earlier clean-state run (does not trust a stale done flag)", async () => {
    mkdirSync(tempDir, { recursive: true });

    const { runMemberCredentialBindingMigration } = await import("../../src/workspace/member-credential-binding-migration.js");
    // First run happens before any legacy data exists (a fresh install boot).
    runMemberCredentialBindingMigration();

    // Real historical data is restored/imported afterward, exactly like a fresh
    // install followed by importing an existing user's legacy members.json.
    writeGlobalMembers([
      { name: "harnessbot", agent: "general", model: "goo73/fake", runtime: "pi-cli", thinkingLevel: "off", id: "ffb62b3a", type: "agent" },
    ]);

    runMemberCredentialBindingMigration();

    const members = JSON.parse(readFileSync(join(tempDir, "members.json"), "utf-8"));
    expect(members[0].model).toBeUndefined();
    expect(members[0].credentialId).toBeUndefined();
    expect(members[0].name).toBe("harnessbot");
  });

  it("is idempotent — a second run makes no further changes and does not duplicate snapshots", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeRoom("room-d", [
      { id: "rm_general", roomId: "room-d", name: "general", sourceAgent: "general", config: { model: "claude-sonnet-4-6" }, createdAt: 1, updatedAt: 1 },
    ]);
    writeGlobalMembers([
      { id: "developer", name: "developer", type: "agent", agent: "developer", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    ]);

    const { runMemberCredentialBindingMigration } = await import("../../src/workspace/member-credential-binding-migration.js");
    runMemberCredentialBindingMigration();
    const snapshotDir = join(tempDir, "pi-agent", "runtime", ".migration-snapshots");
    const afterFirst = readdirSync(snapshotDir).length;

    runMemberCredentialBindingMigration();
    const afterSecond = readdirSync(snapshotDir).length;
    expect(afterSecond).toBe(afterFirst);

    const room = JSON.parse(readFileSync(join(tempDir, "rooms", "room-d", "room.json"), "utf-8"));
    expect(room.roomMembers[0].config).toBeUndefined();
  });
});
