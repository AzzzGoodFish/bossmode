import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const drafts = (names: string[]) => names.map((name) => ({ agent: name, name }));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bossmode-room-member-resolver-"));
  vi.resetModules();
  vi.stubEnv("BOSSMODE_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function writeAgent(name: string, extraFrontmatter = ""): void {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n${extraFrontmatter}---\n${name} prompt\n`, "utf-8");
}

describe("room-member-resolver — no implicit model default", () => {
  it("leaves a freshly created direct Agent member Unconfigured (no model, no credentialId)", async () => {
    writeAgent("architect");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, drafts(["architect"]));
    const resolved = resolveRoomMember(room.id, "architect");

    expect(resolved?.model).toBeUndefined();
    expect(resolved?.credentialId).toBeUndefined();
  });

  it("ignores a legacy model field in Agent definition frontmatter", async () => {
    writeAgent("pm", "model: claude-sonnet-4-6\n");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, drafts(["pm"]));
    const resolved = resolveRoomMember(room.id, "pm");

    expect(resolved?.model).toBeUndefined();
  });

  it("does not synthesize a default model for a legacy global member with model set but no credentialId", async () => {
    writeAgent("developer");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { saveMember } = await import("../../src/workforce/member-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");
    const { runRoomMemberMigration } = await import("../../src/workspace/room-member-migration.js");

    saveMember({ name: "developer", agent: "developer", runtime: "pi-cli", model: "claude-sonnet-4-6", thinkingLevel: "off" });
    const room = roomStore.createRoom("A", dir, drafts(["developer"]));
    // Simulate a pre-v0.14 legacy room with no roomMembers array yet, so migration
    // links this room member back to the legacy global member by sourceMemberId.
    const roomJsonPath = join(roomStore.roomDir(room.id), "room.json");
    const rawRoom = JSON.parse(readFileSync(roomJsonPath, "utf-8"));
    delete rawRoom.roomMembers;
    writeFileSync(roomJsonPath, JSON.stringify(rawRoom, null, 2), "utf-8");
    runRoomMemberMigration();

    const resolved = resolveRoomMember(room.id, "developer");
    expect(resolved?.model).toBe("claude-sonnet-4-6");
    expect(resolved?.credentialId).toBeUndefined();
  });

  it("resolves an explicitly configured member's model and credentialId together", async () => {
    writeAgent("qa");
    const roomStore = await import("../../src/workspace/room-store.js");
    const { resolveRoomMember } = await import("../../src/workforce/room-member-resolver.js");

    const room = roomStore.createRoom("A", dir, drafts(["qa"]));
    roomStore.updateRoomMemberOverride(room.id, "qa", { model: "anthropic/claude-opus-4-6", credentialId: "cred-x" });

    const resolved = resolveRoomMember(room.id, "qa");
    expect(resolved?.model).toBe("anthropic/claude-opus-4-6");
    expect(resolved?.credentialId).toBe("cred-x");
  });
});
