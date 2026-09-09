import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, applyStorageMigrations, bindDatabase, type Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { membersMigration } from "../../src/storage/schema/members.js";
import { settingsMigration } from "../../src/storage/schema/settings.js";
import { conversationsMigration } from "../../src/storage/schema/conversations.js";
import { SettingsRepository, AuthSessionsRepository } from "../../src/storage/repositories/settings.js";
import { getDefaultConfig } from "../../src/shared/config.js";
import { readMcpConfigText, writeMcpConfig } from "../../src/shared/mcp-settings.js";
let root:string,db:Database,server:Server,url:string;
beforeAll(async()=>{
 root=mkdtempSync(join(tmpdir(),"bm-settings-http-")); db=openDatabase(join(root,"db.sqlite"));
 applyStorageMigrations(db,[baseStorageMigration,membersMigration,settingsMigration,conversationsMigration]);bindDatabase(db);
 const {handleApiRequest}=await import("../../src/api/index.js");
 server=createServer((req,res)=>{void handleApiRequest(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}}).catch(error=>{res.writeHead(500);res.end(String(error));});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));url=`http://127.0.0.1:${(server.address() as any).port}`;
});
beforeEach(()=>{
 new SettingsRepository(db).importConfig({...getDefaultConfig(),mcp:{enabled:false}});
 writeMcpConfig({mcpServers:{}});new AuthSessionsRepository(db).set("test-session",Date.now()+3600000);
});
afterEach(()=>{vi.restoreAllMocks();db.exec("DROP TRIGGER IF EXISTS deny_settings");});
afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));db?.close();if(root)rmSync(root,{recursive:true,force:true});});
function request(path:string,body?:unknown){return fetch(url+path,{method:body===undefined?"GET":"PUT",headers:{authorization:"Bearer test-session","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});}
it("returns a real HTTP storage error instead of successful runtime defaults",async()=>{
 vi.spyOn(SettingsRepository.prototype,"read").mockImplementation(()=>{throw new Error("injected storage read failure");});
 const response=await request("/api/settings/runtime");
 expect(response.status).toBe(500);expect(await response.json()).toEqual({error:"Unable to read runtime settings"});
});
it("does not expose argument credentials through actual MCP status JSON",async()=>{
 const secret="credential-sentinel-never-public";
 writeMcpConfig({mcpServers:{one:{command:"server",args:["--api-key",secret,"--token="+secret,"--normal","visible"]}}});
 const response=await request("/api/settings/mcp");expect(response.status).toBe(200);
 const text=await response.text();expect(text).not.toContain(secret);
 const result=JSON.parse(text);expect(result.configPath).toBe(db.path);expect(result.sources[0].label).toBe("Bossmode database");
});
it("rolls back MCP config and enabled state together if the second write fails",async()=>{
 writeMcpConfig({mcpServers:{original:{command:"original"}}});
 db.exec("CREATE TRIGGER deny_settings BEFORE INSERT ON app_settings BEGIN SELECT RAISE(ABORT,'injected settings failure'); END");
 const response=await request("/api/settings/mcp",{enabled:true,configText:JSON.stringify({mcpServers:{replacement:{command:"new"}}})});
 expect(response.status).toBe(500);
 expect(JSON.parse(readMcpConfigText())).toEqual({mcpServers:{original:{command:"original"}}});
 expect(new SettingsRepository(db).read()?.mcp?.enabled).toBe(false);
});
it("commits valid runtime patches without altering unrelated settings",async()=>{
 const response=await request("/api/settings/runtime",{sessionResume:false,codexTransport:"sse",websocketConnectTimeoutMs:125.9});
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({sessionResume:false,codexTransport:"sse",websocketConnectTimeoutMs:125});
 expect(new SettingsRepository(db).read()?.defaults).toEqual({host:"127.0.0.1",port:8080});
});
