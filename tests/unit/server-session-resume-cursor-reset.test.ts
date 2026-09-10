import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/shared/config.js";
import { prepareCoreStorage } from "../../src/storage/core-startup.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import type { Database } from "../../src/storage/database.js";

// Stop at the existing router boundary, AFTER startApplication's cursor policy and
// BEFORE HTTP listeners, catalog refresh, or model execution. No projection mock.
const boundary = vi.hoisted(() => ({ reached: new Error("cursor-policy-observed"), init: vi.fn() }));
vi.mock("../../src/engine/agent-manager.js", () => ({
  initAgentManager: boundary.init,
  wireMentionRouter: () => { throw boundary.reached; },
  shutdownAll: vi.fn(), getActiveInstanceCount: vi.fn(() => 0),
  quiesceMember: vi.fn(async () => { throw new Error("Unexpected archive quiescence"); }),
}));
// Avoid copying package assets; this test owns cursor policy, not builtin seeding.
vi.mock("../../src/workforce/team-updates.js", () => ({ seedBuiltinAssets: vi.fn() }));

let root: string;
let db: Database | undefined;
beforeEach(() => { root = process.env.BOSSMODE_DIR!; mkdirSync(join(root, "knowledge"), {recursive:true}); vi.clearAllMocks(); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, {recursive:true,force:true}); });

describe("server startup cursor policy on SQL authority", () => {
  it.each([false, true, undefined])("sessionResume=%s resets only when explicitly disabled", async sessionResume => {
    const config = getDefaultConfig();
    config.runtime = {...config.runtime, sessionResume};
    const initial = await prepareCoreStorage({root,initialConfig:config,bundledCatalog:[]});
    db = initial.db;
    const rooms = new ConversationsRepository(db);
    for (const id of ["room-1", "room-2"]) rooms.upsertRoom({id,name:id,members:[],createdAt:1});
    rooms.ensureDmScope("mem_owner");
    rooms.setCursor("room-1", "pm", "m1"); rooms.setCursor("room-1", "mem_owner", "m2");
    rooms.setCursor("room-2", "qa", "m3"); rooms.setCursor("dm:mem_owner", "mem_owner", "dm-keep");
    db.close(); db = undefined;
    const { startServer } = await import("../../src/server/index.js");
    await expect(startServer({host:"127.0.0.1",port:0})).rejects.toBe(boundary.reached);
    expect(boundary.init).toHaveBeenCalledOnce();
    const reopened = await prepareCoreStorage({root,bundledCatalog:[]}); db = reopened.db;
    const actual = new ConversationsRepository(db);
    expect(actual.getCursors("room-1")).toEqual(sessionResume === false ? {pm:null,mem_owner:null} : {pm:"m1",mem_owner:"m2"});
    expect(actual.getCursors("room-2")).toEqual({qa:sessionResume === false ? null : "m3"});
    expect(actual.getCursors("dm:mem_owner")).toEqual({mem_owner:"dm-keep"});
  });
});
