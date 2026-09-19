import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { StartupWaitError, waitForStartup } from "../../src/app/cli.js";
let child: EventEmitter;
const processHandle = () => child as unknown as ChildProcess;
beforeEach(()=>{ vi.useFakeTimers(); child=new EventEmitter(); });
afterEach(()=>vi.useRealTimers());
it("does not let unknown IPC messages disable the initial timeout", async()=>{
  const result=waitForStartup(processHandle(),{inactivityMs:30000});
  const failure=expect(result).rejects.toMatchObject({preparationStarted:false});
  await vi.advanceTimersByTimeAsync(20000); child.emit("message",{type:"noise"});
  await vi.advanceTimersByTimeAsync(10000); await failure;
  expect(child.listenerCount("message")).toBe(0);
});
it("keeps the same command waiting across long storage operations instead of killing a progressing upgrade",async()=>{
  const onStall=vi.fn(); let settled=false;
  const result=waitForStartup(processHandle(),{inactivityMs:30000,onStall}); result.then(()=>{settled=true;});
  child.emit("message",{type:"progress",phase:"backing-up",completed:0,total:1});
  await vi.advanceTimersByTimeAsync(180000);
  expect(settled).toBe(false);expect(onStall).toHaveBeenCalledTimes(6);
  child.emit("message",{type:"progress",phase:"importing",completed:100,total:100});
  await vi.advanceTimersByTimeAsync(35000);
  child.emit("message",{type:"ready",host:"127.0.0.1",port:12521});
  await expect(result).resolves.toEqual({type:"ready",host:"127.0.0.1",port:12521});
  expect(vi.getTimerCount()).toBe(0);expect(child.listenerCount("message")).toBe(0);
});
it("does not report readiness on a clean exit that never acknowledged the service",async()=>{
  const result=waitForStartup(processHandle(),{inactivityMs:30000});
  child.emit("exit",0,null);
  await expect(result).rejects.toThrow("before readiness");expect(vi.getTimerCount()).toBe(0);
});
it("marks post-preparation errors so the caller does not blindly terminate a write operation",async()=>{
  const result=waitForStartup(processHandle(),{inactivityMs:30000});
  child.emit("message",{type:"progress",phase:"validating"});
  child.emit("message",{type:"error",message:"Validation failed"});
  await expect(result).rejects.toEqual(new StartupWaitError("Validation failed",true));
});
it("console observer failures do not interrupt preparation",async()=>{
  const result=waitForStartup(processHandle(),{inactivityMs:30000,onProgress:()=>{throw new Error("broken output");},onStall:()=>{throw new Error("broken output");}});
  child.emit("message",{type:"progress",phase:"cutover"});
  await vi.advanceTimersByTimeAsync(60000);
  child.emit("message",{type:"ready",host:"localhost",port:12521,mode:"recovery"});
  await expect(result).resolves.toMatchObject({mode:"recovery"});
});
