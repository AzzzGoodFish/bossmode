/**
 * cleanup-member-overrides-v1 (fish approved 2026-08-04): room.json
 * memberOverrides residue is dead weight in stamped rooms (the read side
 * never consults it since 0.20). Permanent assertions: residue cleared with
 * snapshot, new-authority config untouched, live-intent-looking entries kept
 * + warned, legacy unstamped rooms skipped, idempotent re-run.
 * Fixtures mirror production shapes: entries keyed by mem_* (today's model
 * switches) and by legacy member name (codex era), in stamped rooms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

function seedAgent(name: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n---\n\nYou are ${name}.\n`, "utf-8");
}

const PROFILE = {
  name: "Test provider",
  providerSlug: "testprov",
  protocol: "openai-responses" as const,
  baseUrl: "https://example.invalid/v1",
  authType: "api_key" as const,
  apiKey: "sk-test",
  requestProfile: "standard" as const,
  enabled: true,
  isDefault: true,
  models: [
    { id: "claude-a", contextWindow: 100000, maxTokens: 8000, input: ["text" as const] },
    { id: "claude-b", contextWindow: 200000, maxTokens: 8000, input: ["text" as const] },
  ],
};

async function seedCredential() {
  const creds = await import("../../src/engine/model-credentials.js");
  return creds.saveModelCredentialProfile(PROFILE);
}

async function makeStampedRoom(memberId: string, memberName = "pm", roomName = "R") {
  const roomStore = await import("../../src/workspace/room-store.js");
  const room = roomStore.createRoom(roomName, dir, [{ agent: memberName, name: memberName }], undefined);
  roomStore.stampGlobalMemberIds(room.id, [memberId], memberId);
  return room;
}

function writeOverrides(roomId: string, overrides: Record<string, unknown>) {
  const path = join(dir, "rooms", roomId, "room.json");
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  raw.memberOverrides = overrides;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}

function readOverrides(roomId: string): Record<string, unknown> | undefined {
  const raw = JSON.parse(readFileSync(join(dir, "rooms", roomId, "room.json"), "utf-8"));
  return raw.memberOverrides;
}

describe("cleanup-member-overrides-v1", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-oc-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "knowledge", "docs"), { recursive: true });
    seedAgent("pm");
    seedAgent("qa");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears dead residue (mem_* duplicates, codex-era name keys, ghosts); registry config untouched; snapshot + idempotent", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-b", credentialId: cred.id });
    const room = await makeStampedRoom(member.id);

    // Production-shaped residue: ①mem_* entry duplicating the live binding
    // (re-switched model), ②codex-era name-keyed dead config, ③ghost entry.
    writeOverrides(room.id, {
      [member.id]: { model: "testprov/claude-b", credentialId: cred.id },
      pm: { model: "openai/gpt-5.3-codex", thinkingLevel: "xhigh" },
      "mem_ghost-0000": { model: "testprov/claude-a" },
    });

    const before = reg.getEffectiveConfig(member.id, `room:${room.id}`);
    const migration = await import("../../src/workspace/member-overrides-cleanup-migration.js");
    const result = migration.runMemberOverridesCleanupMigration();

    expect(result.entriesRemoved).toBe(3);
    expect(result.entriesKeptSuspicious).toBe(0);
    expect(result.legacyRoomsSkipped).toBe(0);
    expect(readOverrides(room.id)).toBeUndefined();
    // New authority untouched.
    expect(reg.getEffectiveConfig(member.id, `room:${room.id}`)).toEqual(before);
    expect(reg.getMember(member.id)?.global.model).toBe("testprov/claude-b");
    // Snapshot of the pre-mutation room.json exists and still shows residue.
    const snap = join(dir, "pi-agent", "runtime", ".migration-snapshots", "cleanup-member-overrides-v1", room.id, "room.json");
    expect(existsSync(snap)).toBe(true);
    expect(JSON.parse(readFileSync(snap, "utf-8")).memberOverrides.pm).toEqual({ model: "openai/gpt-5.3-codex", thinkingLevel: "xhigh" });
    // Marker written for observability.
    expect(existsSync(join(dir, ".migrations", "cleanup-member-overrides-v1.json"))).toBe(true);

    // Idempotent re-run: no residue → no work.
    const again = migration.runMemberOverridesCleanupMigration();
    expect(again.entriesRemoved).toBe(0);
    expect(readOverrides(room.id)).toBeUndefined();
  });

  it("keeps + warns an entry that looks like a live intent not in the new authority", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({ name: "qa", agentTemplate: "qa", model: "testprov/claude-a", credentialId: cred.id });
    const room = await makeStampedRoom(member.id, "qa");

    // An AVAILABLE model differing from the effective binding: could be a
    // lost scope intent — never hard-cleared.
    writeOverrides(room.id, {
      qa: { model: "testprov/claude-b", credentialId: cred.id },
    });

    const migration = await import("../../src/workspace/member-overrides-cleanup-migration.js");
    const result = migration.runMemberOverridesCleanupMigration();
    expect(result.entriesRemoved).toBe(0);
    expect(result.entriesKeptSuspicious).toBe(1);
    expect(readOverrides(room.id)).toEqual({ qa: { model: "testprov/claude-b", credentialId: cred.id } });

    // Same-field duplicate of the new authority IS dead (fish-restored intent).
    writeOverrides(room.id, { qa: { model: "testprov/claude-a", credentialId: cred.id, mcpServers: [] } });
    const result2 = migration.runMemberOverridesCleanupMigration();
    expect(result2.entriesRemoved).toBe(1);
    expect(readOverrides(room.id)).toBeUndefined();
  });

  it("restored live intent (qa playwright case): old entry matching the new authority is cleared", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    const member = reg.createMember({
      name: "qa",
      agentTemplate: "qa",
      model: "testprov/claude-a",
      credentialId: cred.id,
      unifiedExtensions: false, // scope overrides only apply when extensions are not unified
    });
    const room = await makeStampedRoom(member.id, "qa");
    // fish restored playwright into the new authority (scope override).
    reg.patchScopeOverride(member.id, `room:${room.id}`, { mcpServers: ["playwright"] });

    writeOverrides(room.id, { qa: { mcpServers: ["playwright"] } });
    const migration = await import("../../src/workspace/member-overrides-cleanup-migration.js");
    const result = migration.runMemberOverridesCleanupMigration();
    expect(result.entriesRemoved).toBe(1);
    expect(readOverrides(room.id)).toBeUndefined();
    // The restored scope override is untouched.
    expect(reg.getEffectiveConfig(member.id, `room:${room.id}`).mcpServers).toEqual(["playwright"]);
  });

  it("legacy unstamped room: memberOverrides still authoritative → skipped entirely", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const cred = await seedCredential();
    reg.createMember({ name: "pm", agentTemplate: "pm", model: "testprov/claude-a", credentialId: cred.id });
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("Legacy", dir, [{ agent: "pm", name: "pm" }], undefined);
    // No stampGlobalMemberIds — legacy read side consults memberOverrides.
    writeOverrides(room.id, { pm: { thinkingLevel: "high" } });

    const migration = await import("../../src/workspace/member-overrides-cleanup-migration.js");
    const result = migration.runMemberOverridesCleanupMigration();
    expect(result.legacyRoomsSkipped).toBe(1);
    expect(result.entriesRemoved).toBe(0);
    expect(readOverrides(room.id)).toEqual({ pm: { thinkingLevel: "high" } });
  });
});
