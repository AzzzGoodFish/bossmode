import { afterEach, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIsAlive, stopDaemonProcess } from "../../src/app/process.js";
let root:string|undefined,child:ChildProcess|undefined;
async function start(ignore=false) {
 root=mkdtempSync(join(tmpdir(),"bm-stop-process-")); const script=join(root,"child.cjs");
 writeFileSync(script,`const fs=require('node:fs');setInterval(()=>{},1000);process.on('SIGTERM',()=>{${ignore?"":"setTimeout(()=>{fs.writeFileSync("+JSON.stringify(join(root,"finished"))+",'drained');process.exit(0);},150);"}});process.send('ready');`);
 child=fork(script,[],{stdio:["ignore","ignore","ignore","ipc"],env:{...process.env,HOME:root,BOSSMODE_DIR:join(root,"data")}});
 await new Promise<void>((resolve,reject)=>{child!.once("message",()=>resolve());child!.once("error",reject);});
 return child.pid!;
}
afterEach(async()=>{
 if(child&&child.exitCode===null&&child.signalCode===null){const done=new Promise<void>(resolve=>child!.once("exit",()=>resolve()));child.kill("SIGKILL");await done;}
 if(root)rmSync(root,{recursive:true,force:true});root=undefined;child=undefined;
});
it("waits for the old writer to finish draining before acknowledging stop",async()=>{
 const pid=await start();await stopDaemonProcess(pid,3000);
 expect(processIsAlive(pid)).toBe(false);expect(readFileSync(join(root!,"finished"),"utf8")).toBe("drained");
});
it("fails without force-killing a writer that has not exited",async()=>{
 const pid=await start(true);await expect(stopDaemonProcess(pid,75)).rejects.toThrow("ownership was retained");expect(processIsAlive(pid)).toBe(true);
});
it("rejects process identities that must not be signalled",async()=>{
 await expect(stopDaemonProcess(1)).rejects.toThrow("Invalid daemon");await expect(stopDaemonProcess(process.pid)).rejects.toThrow("Invalid daemon");
});
