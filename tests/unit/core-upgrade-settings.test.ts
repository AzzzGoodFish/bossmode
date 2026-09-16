import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join,dirname} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/data/database.js";
import {coreStorageMigrations} from "../../src/data/migrations.js";
import {discoverLegacyInventory} from "../../src/data/upgrade/legacy-inventory.js";
import {decodeLegacyConfig,importLegacySettings} from "../../src/data/upgrade/upgrade-settings.js";
import {McpOauthRepository,mcpOauthServerKey} from "../../src/data/repositories/mcp-oauth.js";
import {SettingsRepository} from "../../src/data/repositories/settings.js";
import {McpSettingsRepository} from "../../src/data/repositories/mcp-settings.js";
import type {UpgradeImportContext} from "../../src/data/upgrade/upgrade-runner.js";
let db:Database|undefined;let root:string|undefined;
afterEach(()=>{db?.close();db=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
function setup(files:Record<string,unknown>){
 root=mkdtempSync(join(tmpdir(),"upgrade-settings-"));const sourceRoot=join(root,"snapshot");mkdirSync(sourceRoot);
 for(const [path,value]of Object.entries(files)){const file=join(sourceRoot,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));}
 db=openDatabase(join(root,"stage.sqlite"));applyStorageMigrations(db,coreStorageMigrations);
 const entries=discoverLegacyInventory(sourceRoot).entries;
 const ctx:UpgradeImportContext={db,root,sourceRoot,previousDatabase:undefined,sourceFiles:entries.map(e=>e.path),legacy:true,progress(){},stageAsset(){throw new Error("unexpected asset staging");}};
 return {ctx,entries};
}
const config={auth:{username:"owner",passwordHash:"unchanged-hash"},defaults:{host:"127.0.0.1",port:12521},apiKeys:{provider:"private-key"},sessionResume:false};
it("imports only the snapshotted configuration and ignores the retired resume setting",()=>{
 const {ctx,entries}=setup({"config.json":config});writeFileSync(join(ctx.root,"config.json"),"poison live source");
 expect([...importLegacySettings(ctx,entries,[])]).toEqual(["config.json"]);
 expect(new SettingsRepository(ctx.db).read()).toMatchObject({auth:config.auth,defaults:config.defaults,apiKeys:config.apiKeys});
 expect(new SettingsRepository(ctx.db).read()).not.toHaveProperty("sessionResume");
 expect(new SettingsRepository(ctx.db).read()).not.toHaveProperty("runtime");
});
it("creates empty setup configuration for a genuinely absent source",()=>{
 const {ctx,entries}=setup({});expect(importLegacySettings(ctx,entries,[]).size).toBe(0);
 expect(new SettingsRepository(ctx.db).read()?.auth).toEqual({username:"",passwordHash:""});
});
it("imports orphaned hashed MCP OAuth data without guessing URL or resuming authorization",()=>{
 const key=mcpOauthServerKey("removed-server");const path=`mcp/runtime/oauth/sha256-${key}/tokens.json`;
 const value={tokens:{accessToken:"fixture-token",expiresAt:0},clientInfo:{clientId:"fixture-client",redirectUris:[]},codeVerifier:"retained-verifier",oauthState:"retained-state"};
 const {ctx,entries}=setup({[path]:value});expect(importLegacySettings(ctx,entries,[]).has(path)).toBe(true);
 expect(new McpOauthRepository(ctx.db).read("removed-server")).toEqual(value);
});
it("refuses the unsupported flat OAuth format instead of importing an empty entry",()=>{
 const path=`mcp/runtime/oauth/sha256-${mcpOauthServerKey("old")}/tokens.json`;
 const {ctx,entries}=setup({[path]:{access_token:"not-to-be-logged",expiresAt:12}});
 expect(()=>importLegacySettings(ctx,entries,[])).toThrow();
 expect(ctx.db.all("SELECT * FROM mcp_oauth_entries")).toEqual([]);
});
it("rejects malformed existing configuration rather than resetting authentication",()=>{
 for(const value of [{}, {...config,auth:null},{...config,auth:{username:"owner",passwordHash:42}},{...config,apiKeys:{key:{secret:"private"}}}])expect(()=>decodeLegacyConfig(value)).toThrow(/Invalid legacy/);
});
it("does not treat member directory labels as proven settings ownership",()=>{
 const {ctx,entries}=setup({"members/mem_unknown/mcp.json":{mcpServers:{}}});
 expect(()=>importLegacySettings(ctx,entries,[])).toThrow("Unproven member settings owner");
});
it("refuses unsnapshotted paths even when the source file exists",()=>{
 const {ctx,entries}=setup({"config.json":config});
 expect(()=>importLegacySettings({...ctx,sourceFiles:[]},entries,[])).toThrow("Unsnapshotted legacy source");
});
it("rejects file-backed source conversion inside an ambient transaction",()=>{
 const {ctx,entries}=setup({});
 expect(()=>ctx.db.transaction(()=>importLegacySettings(ctx,entries,[]))).toThrow(/outside|transaction/i);
});
it("imports empty MCP definitions as empty, not global file fallback",()=>{
 const {ctx,entries}=setup({"mcp/mcp.json":{mcpServers:{}}});
 const consumed=importLegacySettings(ctx,entries,[]);expect(consumed.has("mcp/mcp.json")).toBe(true);
 expect(new McpSettingsRepository(ctx.db).read()).toEqual({mcpServers:{}});
});
