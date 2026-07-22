import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

describe("team-store", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-team-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "pm.md"), `---\nname: pm\ndescription: PM role\n---\n\n# PM\n`, "utf-8");
    writeFileSync(join(dir, "agents", "developer.md"), `---\nname: developer\ndescription: Dev role\nskills: [ship]\n---\n\n# Developer\n`, "utf-8");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds a default team from global agents and lists it", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    const seeded = mod.seedDefaultTeamTemplatesFromAgents();
    expect(seeded.created.length).toBe(1);
    const list = mod.listTeamTemplates();
    expect(list.length).toBe(1);
    expect(list[0].agentNames).toEqual(expect.arrayContaining(["pm", "developer"]));
    const team = mod.getTeamTemplate(list[0].slug);
    expect(team?.agents.find((a) => a.name === "developer")?.skills).toContain("ship");
  });

  it("copies a template into a room team path", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    mod.seedDefaultTeamTemplatesFromAgents();
    const dest = join(dir, "rooms", "r1", "team");
    mod.copyTeamTemplateTo("default-team", dest);
    expect(existsSync(join(dest, "team.md"))).toBe(true);
    expect(existsSync(join(dest, "agents", "pm.md"))).toBe(true);
    const agent = mod.loadRoomTeamAgent("r1", "pm");
    expect(agent?.name).toBe("pm");
  });

  it("imports and exports a zip package", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    mod.seedDefaultTeamTemplatesFromAgents();
    const zipPath = join(dir, "pack.zip");
    mod.exportTeamToZip("default-team", zipPath);
    expect(existsSync(zipPath)).toBe(true);
    // wipe teams and re-import
    rmSync(join(dir, "teams"), { recursive: true, force: true });
    const imported = mod.importTeamFromZip(zipPath);
    expect(imported.agents.length).toBeGreaterThan(0);
    expect(mod.listTeamTemplates().length).toBe(1);
  });

  it("team-layer migration backfills room team packages", async () => {
    // prepare a room without team/
    const roomId = "room-a";
    mkdirSync(join(dir, "rooms", roomId), { recursive: true });
    writeFileSync(join(dir, "rooms", roomId, "room.json"), JSON.stringify({
      id: roomId,
      name: "Room A",
      cwd: "/tmp",
      members: ["pm"],
      roomMembers: [{ id: "rm1", roomId, name: "pm", sourceAgent: "pm", createdAt: 1, updatedAt: 1 }],
      createdAt: 1,
    }, null, 2));
    const mig = await import("../../src/workspace/team-layer-migration.js");
    mig.runTeamLayerMigration();
    expect(existsSync(join(dir, "rooms", roomId, "team", "agents", "pm.md"))).toBe(true);
    expect(existsSync(join(dir, "teams", "default-team", "team.md"))).toBe(true);
    // idempotent
    mig.runTeamLayerMigration();
    expect(readFileSync(join(dir, "rooms", roomId, "team", "team.md"), "utf-8")).toContain("Migrated");
  });
});
