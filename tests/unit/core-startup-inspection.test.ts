import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectStartupSettings } from "../../src/data/upgrade/startup-inspection.js";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
const settingsMigration = getMigration("core-settings-v1");
import { SettingsRepository } from "../../src/data/repositories/settings.js";
import { getDefaultConfig } from "../../src/config/config.js";
let root:string,db:Database|undefined;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"bm-startup-peek-"));});
afterEach(()=>{db?.close();db=undefined;rmSync(root,{recursive:true,force:true});});
it("does not create storage or configuration while inspecting an empty root",()=>{
 expect(inspectStartupSettings(root)).toEqual({configured:false,source:"empty"});
 expect(existsSync(join(root,"bossmode.db"))).toBe(false);expect(existsSync(join(root,"config.json"))).toBe(false);
});
it("reads only pre-cutover legacy setup/display fields without rewriting their bytes",()=>{
 const content=JSON.stringify({...getDefaultConfig(),auth:{username:"operator",passwordHash:"private-hash"}})+"\n";
 writeFileSync(join(root,"config.json"),content);
 const result=inspectStartupSettings(root);expect(result).toEqual({configured:true,source:"legacy",host:"127.0.0.1",port:8080});
 expect(JSON.stringify(result)).not.toContain("private-hash");expect(readFileSync(join(root,"config.json"),"utf8")).toBe(content);
});
it("uses authoritative DB settings and never parses leftover config files",()=>{
 db=openDatabase(join(root,"bossmode.db"));applyStorageMigrations(db,[baseStorageMigration,settingsMigration]);
 new SettingsRepository(db).importConfig({...getDefaultConfig(),defaults:{host:"localhost",port:12521}});
 db.run("INSERT INTO storage_meta VALUES('core-authority',?)",JSON.stringify({format:1,schema:"test"}));
 writeFileSync(join(root,"config.json"),"poison legacy file");
 expect(inspectStartupSettings(root)).toEqual({configured:true,source:"database",host:"localhost",port:12521});
});
it("refuses account replacement when marked authoritative configuration is missing",()=>{
 db=openDatabase(join(root,"bossmode.db"));applyStorageMigrations(db,[baseStorageMigration,settingsMigration]);
 db.run("INSERT INTO storage_meta VALUES('core-authority',?)",JSON.stringify({format:1,schema:"test"}));
 writeFileSync(join(root,"config.json"),JSON.stringify(getDefaultConfig()));
 expect(()=>inspectStartupSettings(root)).toThrow("refusing account replacement");
});
it("never falls back to legacy settings for unreadable storage",()=>{
 writeFileSync(join(root,"bossmode.db"),"not a database");
 writeFileSync(join(root,"config.json"),JSON.stringify(getDefaultConfig()));
 expect(()=>inspectStartupSettings(root)).toThrow();
});

it("refuses a newer storage format instead of using a legacy account",()=>{
 db=openDatabase(join(root,"bossmode.db"));applyStorageMigrations(db,[baseStorageMigration,settingsMigration]);
 db.run("INSERT INTO storage_meta VALUES('core-authority',?)",JSON.stringify({format:2,schema:"future"}));
 writeFileSync(join(root,"config.json"),JSON.stringify(getDefaultConfig()));
 expect(()=>inspectStartupSettings(root)).toThrow("Unsupported storage format");
});
