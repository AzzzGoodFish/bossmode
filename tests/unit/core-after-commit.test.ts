import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Database } from "../../src/storage/database.js";
let root:string,db:Database;
const observerError=vi.fn();
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"bm-after-commit-"));observerError.mockReset();db=openDatabase(join(root,"db.sqlite"),{onPostCommitError:observerError});db.exec("CREATE TABLE records(id TEXT PRIMARY KEY)");});
afterEach(()=>{db.close();rmSync(root,{recursive:true,force:true});});
it("defers nested effects until outer commit and permits observing the committed connection",()=>{
 const effects:string[]=[];
 db.transaction(tx=>{
   tx.run("INSERT INTO records VALUES('one')");
   tx.afterCommit(()=>{expect(db.get("SELECT id FROM records")?.id).toBe("one");effects.push("first");});
   tx.transaction(inner=>inner.afterCommit(()=>effects.push("nested")));
   expect(effects).toEqual([]);
 });
 expect(effects).toEqual(["first","nested"]);
});
it("discards all effects on outer rollback",()=>{
 const effect=vi.fn();
 expect(()=>db.transaction(tx=>{tx.transaction(inner=>inner.afterCommit(effect));throw new Error("rollback");})).toThrow("rollback");
 expect(effect).not.toHaveBeenCalled();
 db.transaction(()=>{});expect(effect).not.toHaveBeenCalled();
});
it("discards only the failed nested frame when its outer transaction can commit",()=>{
 const effects:string[]=[];
 db.transaction(tx=>{
   tx.afterCommit(()=>effects.push("outer"));
   try {tx.transaction(inner=>{inner.afterCommit(()=>effects.push("discard"));throw new Error("nested");});} catch {}
   tx.afterCommit(()=>effects.push("after"));
 });
 expect(effects).toEqual(["outer","after"]);
});
it("does not emit after a native OR ROLLBACK poisons the outer transaction",()=>{
 const effect=vi.fn();
 expect(()=>db.transaction(tx=>{
   tx.afterCommit(effect);tx.run("INSERT INTO records VALUES('one')");
   try{tx.transaction(inner=>inner.run("INSERT OR ROLLBACK INTO records VALUES('one')"));}catch{}
 })).toThrow();
 expect(effect).not.toHaveBeenCalled();expect(db.all("SELECT * FROM records")).toEqual([]);
});
it("never turns an observer exception into a false rollback or drops subsequent observers",()=>{
 const effect=vi.fn();
 expect(db.transaction(tx=>{tx.run("INSERT INTO records VALUES('one')");tx.afterCommit(()=>{throw new Error("observer failure");});tx.afterCommit(effect);return "committed";})).toBe("committed");
 expect(db.get("SELECT id FROM records")?.id).toBe("one");expect(effect).toHaveBeenCalledOnce();expect(observerError).toHaveBeenCalledOnce();
});
it("runs immediate effects outside transactions, and safely observes asynchronous rejection",async()=>{
 const effect=vi.fn();db.afterCommit(effect);expect(effect).toHaveBeenCalledOnce();
 db.afterCommit(async()=>{throw new Error("async observer failure");});
 await Promise.resolve();expect(observerError).toHaveBeenCalledOnce();
});
it("allows a fresh transaction in an after-commit effect",()=>{
 db.transaction(tx=>tx.afterCommit(()=>db.transaction(inner=>inner.run("INSERT INTO records VALUES('later')"))));
 expect(db.get("SELECT id FROM records")?.id).toBe("later");expect(observerError).not.toHaveBeenCalled();
});
it("rejects registration through an expired transaction context",()=>{
 let saved:Database;
 db.transaction(tx=>{saved=tx;});
 expect(()=>saved!.afterCommit(()=>{})).toThrow("expired");
});

it("rejects file/async service boundaries inside tracked or raw SQL transactions",()=>{
 expect(()=>db.assertOutsideTransaction()).not.toThrow();
 db.transaction(tx=>expect(()=>tx.assertOutsideTransaction()).toThrow("no enclosing"));
 db.exec("BEGIN");try{expect(()=>db.assertOutsideTransaction()).toThrow("no enclosing");}finally{db.exec("ROLLBACK");}
});
