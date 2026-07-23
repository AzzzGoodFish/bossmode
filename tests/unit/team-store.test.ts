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

  it("syncs packaged builtin Dev Team and lists it with leader first + builtIn", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    const synced = mod.syncBuiltinTeamTemplates();
    expect(synced.synced).toContain("dev");
    const list = mod.listTeamTemplates();
    const dev = list.find((t) => t.slug === "dev");
    expect(dev).toBeTruthy();
    expect(dev!.builtIn).toBe(true);
    expect(dev!.leader).toBe("pm");
    expect(dev!.agentNames[0]).toBe("pm"); // leader first
    expect(dev!.agentNames).toEqual(expect.arrayContaining(["pm", "architect", "developer", "qa", "designer", "dev-ben"]));

    // get by display name (spaces) and by slug
    expect(mod.getTeamTemplate("Dev Team")?.slug).toBe("dev");
    expect(mod.getTeamTemplate("dev")?.meta.type).toBe("builtin");
  });

  it("copies a template into a room team path", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    mod.syncBuiltinTeamTemplates();
    const dest = join(dir, "rooms", "r1", "team");
    mod.copyTeamTemplateTo("dev", dest);
    expect(existsSync(join(dest, "team.md"))).toBe(true);
    expect(existsSync(join(dest, "agents", "pm.md"))).toBe(true);
    const agent = mod.loadRoomTeamAgent("r1", "pm");
    expect(agent?.name).toBe("pm");
  });

  it("syncs builtin Dev Team designer with impeccable skill, including into room copies", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    mod.syncBuiltinTeamTemplates();
    const designerContent = readFileSync(join(dir, "teams", "dev", "agents", "designer.md"), "utf-8");
    expect(designerContent).toMatch(/skills:\s*\n\s*-\s*impeccable/);

    const dest = join(dir, "rooms", "r2", "team");
    mod.copyTeamTemplateTo("dev", dest);
    const roomDesignerContent = readFileSync(join(dest, "agents", "designer.md"), "utf-8");
    expect(roomDesignerContent).toMatch(/skills:\s*\n\s*-\s*impeccable/);
  });

  it("imports and exports a zip package", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    mod.syncBuiltinTeamTemplates();
    const zipPath = join(dir, "pack.zip");
    mod.exportTeamToZip("dev", zipPath);
    expect(existsSync(zipPath)).toBe(true);
    rmSync(join(dir, "teams"), { recursive: true, force: true });
    const imported = mod.importTeamFromZip(zipPath);
    expect(imported.agents.length).toBeGreaterThanOrEqual(6);
    expect(mod.listTeamTemplates().length).toBe(1);
  });

  it("team-layer migration backfills room team packages and syncs builtin", async () => {
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
    expect(existsSync(join(dir, "teams", "dev", "team.md"))).toBe(true);
    mig.runTeamLayerMigration();
    expect(readFileSync(join(dir, "rooms", roomId, "team", "team.md"), "utf-8")).toContain("Migrated");
  });

  it("seeds Default Team only when no teams exist at all", async () => {
    const mod = await import("../../src/workspace/team-store.js");
    // No packaged builtins if we empty... packaged always exists in repo.
    // After syncBuiltin, seed creates nothing more.
    mod.syncBuiltinTeamTemplates();
    const seeded = mod.seedDefaultTeamTemplatesFromAgents();
    expect(seeded.created.length).toBe(0);
    expect(mod.listTeamTemplates().some((t) => t.slug === "dev")).toBe(true);
  });
});
