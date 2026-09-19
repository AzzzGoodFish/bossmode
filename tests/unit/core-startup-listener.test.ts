import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { closeHttpServer, listenAndPublish } from "../../src/app/server.js";

it("awaits cleanup after publication failure, releases the port and permits a fresh retry", async () => {
  const server=createServer();let port=0;let cleanupStarted!:()=>void;let release!:()=>void;
  const started=new Promise<void>(resolve=>cleanupStarted=resolve);
  const gate=new Promise<void>(resolve=>release=resolve);
  let settled=false;
  const attempt=listenAndPublish(server,{host:"127.0.0.1",port:0},()=>{
    port=(server.address() as any).port;throw new Error("PID publication failed");
  },async()=>{cleanupStarted();await gate;await closeHttpServer(server);});
  const rejected=expect(attempt).rejects.toThrow("PID publication failed");
  void attempt.then(()=>settled=true,()=>settled=true);
  await started;expect(settled).toBe(false);expect(server.listening).toBe(true);
  release();await rejected;expect(server.listening).toBe(false);
  const retry=createServer();const publish=vi.fn();
  try {await listenAndPublish(retry,{host:"127.0.0.1",port},publish,()=>closeHttpServer(retry));expect(publish).toHaveBeenCalledOnce();}
  finally {await closeHttpServer(retry);}
});

it("reports occupied ports without publishing readiness and retains cleanup errors", async () => {
  const owner=createServer();await listenAndPublish(owner,{host:"127.0.0.1",port:0},()=>{},()=>closeHttpServer(owner));
  try {
    const candidate=createServer();const publish=vi.fn();const cleanup=vi.fn(async()=>{throw new Error("cleanup failed");});
    let failure:any;
    try {await listenAndPublish(candidate,{host:"127.0.0.1",port:(owner.address() as any).port},publish,cleanup);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors.map((e:Error)=>e.message).join(" ")).toMatch(/already in use.*cleanup failed/);
    expect(publish).not.toHaveBeenCalled();expect(cleanup).toHaveBeenCalledOnce();await closeHttpServer(owner);
    const retryPublication=vi.fn();
    try {
      await listenAndPublish(candidate,{host:"127.0.0.1",port:0},retryPublication,()=>closeHttpServer(candidate));
      expect(retryPublication).toHaveBeenCalledOnce();expect(publish).not.toHaveBeenCalled();
    } finally {await closeHttpServer(candidate);}
  } finally {await closeHttpServer(owner);}
});
