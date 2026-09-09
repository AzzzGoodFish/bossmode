import {afterEach,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {openDatabase,applyStorageMigrations,type Database} from "../../src/storage/database.js";
import {coreStorageMigrations} from "../../src/storage/migrations.js";
const roots:string[]=[];const handles:Database[]=[];
function database(){const root=mkdtempSync(join(tmpdir(),"core-plan-"));roots.push(root);const db=openDatabase(join(root,"bossmode.db"));handles.push(db);return db;}
afterEach(()=>{for(const db of handles.splice(0))db.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it("applies every domain with explicit ordering and leaves no invalid foreign keys",()=>{
 const db=database();applyStorageMigrations(db,coreStorageMigrations);
 for(const table of ["members","rooms","tasks","messages","agent_events","memory_documents","member_archives","mcp_oauth_entries"]){expect(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table)).toBeDefined();}
 expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
 expect(db.get<{integrity_check:string}>("PRAGMA integrity_check")?.integrity_check).toBe("ok");
 db.run("INSERT INTO storage_meta VALUES ('test-preserved','yes')");
 applyStorageMigrations(db,coreStorageMigrations);
 expect(db.get<{value:string}>("SELECT value FROM storage_meta WHERE key='test-preserved'")?.value).toBe("yes");
});
it("preserves converted member authority while replacing only old projection tables",()=>{
 const db=database();
 db.exec(`CREATE TABLE members(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,title TEXT,agent_template TEXT NOT NULL,global_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE tasks(room_id TEXT,task_id TEXT);
 CREATE TABLE activity_events(id TEXT);
 CREATE TABLE token_usage_daily(room_id TEXT,date TEXT);
 INSERT INTO tasks VALUES ('not-authority','projection');`);
 db.run("INSERT INTO members VALUES (?,?,?,?,?,?,?,?)","mem_retained","言实","言实","Engineer","general",'{"skills":[],"model":null}',1,2);
 applyStorageMigrations(db,coreStorageMigrations);
 expect(db.get("SELECT id,name,title,global_json,archived_at FROM members")).toMatchObject({id:"mem_retained",name:"言实",title:"Engineer",global_json:'{"skills":[],"model":null}',archived_at:null});
 expect(db.all("SELECT * FROM tasks")).toEqual([]);
 expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
});
