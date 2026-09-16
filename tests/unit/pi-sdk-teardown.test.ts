/**
 * PiSdkAgentHandle teardown semantics against the REAL SDK ExtensionRunner
 * (architect 2026-09-07 12:12): emit() catches handler throws and reports via
 * onError — never by rejecting the awaited promise. Verified here:
 *  T1 async shutdown handler delay is awaited before teardown settles
 *  T2 a throwing shutdown handler surfaces through destroyAndWait (onError collection)
 *  T3 dispose failure aggregates into the same teardown error (and still runs
 *     after other stages fail)
 *  T4 repeated destroyAndWait calls all await the SAME settlement (no early return)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

vi.mock("../../src/workspace/extension-store.js", () => ({
  resolveMemberExtensionPaths: () => [],
  resolveMemberExtensionSkillPaths: () => [],
}));
vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PiSdkAgentHandle } from "../../src/agent/runtime/pi-sdk.js";
import { coreFixture } from "../helpers/core-fixture.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('t','Teardown owner','teardown owner','test','{}',1,1)");
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('t','room','t')");
});
afterEach(() => { fixture.close(); vi.restoreAllMocks(); });

function realRunner(handler: (event: any, ctx: any) => Promise<void> | void): ExtensionRunner {
  const extensions = [
    { path: "/ext/teardown-test", handlers: new Map([["session_shutdown", [handler]]]) },
  ];
  const runner = new ExtensionRunner(extensions as any, {} as any, process.cwd(), undefined as any, undefined as any);
  return runner;
}

function handleWith(runner: ExtensionRunner, disposeImpl?: () => void): InstanceType<typeof PiSdkAgentHandle> {
  const session: any = {
    subscribe: () => () => {},
    abort: async () => {},
    abortCompaction: () => {},
    abortBranchSummary: () => {},
    dispose: disposeImpl ?? (() => {}),
    extensionRunner: runner,
    sessionId: "teardown-test-session",
    sessionFile: "/tmp/teardown-test-session.jsonl",
    model: { provider: "test", id: "m" },
    thinkingLevel: "off",
  };
  return new PiSdkAgentHandle(
    session,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    [],
    [],
    { model: "test/m", thinkingLevel: "off" },
    [],
    { roomId: "room:t", memberId: "t", agentName: "Teardown owner", roomMembers: ["Teardown owner"] },
  ) as any;
}

describe("PiSdkAgentHandle teardown (real ExtensionRunner)", () => {
  it("T1: awaits an async shutdown handler before settling", async () => {
    let handlerDone = false;
    const runner = realRunner(async () => {
      await new Promise((r) => setTimeout(r, 80));
      handlerDone = true;
    });
    const handle = handleWith(runner);
    let settled = false;
    const p = handle.destroyAndWait!().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(handlerDone).toBe(false); // still waiting for the handler
    expect(settled).toBe(false);
    await p;
    expect(handlerDone).toBe(true);
    expect(settled).toBe(true);
  });

  it("T2: a throwing shutdown handler surfaces via onError collection, not a silent success", async () => {
    const runner = realRunner(async () => {
      throw new Error("shutdown handler exploded");
    });
    const handle = handleWith(runner);
    await expect(handle.destroyAndWait!()).rejects.toThrow(/teardown incomplete/);
    await expect(handle.destroyAndWait!()).rejects.toThrow(/shutdown handler exploded/);
  });

  it("T3: dispose failure is aggregated and dispose still runs after a handler failure", async () => {
    let disposed = false;
    const runner = realRunner(async () => {
      throw new Error("handler boom");
    });
    const handle = handleWith(runner, () => {
      disposed = true;
      throw new AggregateError([new Error("ws pool refused"), new Error("file handle leak")], "Failed to cleanup session resources");
    });
    await expect(handle.destroyAndWait!()).rejects.toThrow(/teardown incomplete \(2\)/);
    expect(disposed).toBe(true); // dispose ran despite the handler failure
    const errText = await handle.destroyAndWait!().then(() => "", (e: Error) => e.message);
    expect(errText).toContain("ws pool refused");
    expect(errText).toContain("file handle leak");
  });

  it("T4: repeated destroyAndWait awaits the same settlement; destroy() shares the path", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const runner = realRunner(async () => { await gate; });
    const handle = handleWith(runner);
    const p1 = handle.destroyAndWait!();
    const p2 = handle.destroyAndWait!(); // repeats wait for the first teardown
    handle.destroy(); // void caller — same settlement, ignored
    let settled = false;
    void Promise.all([p1, p2]).then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release?.();
    await Promise.all([p1, p2]);
    expect(settled).toBe(true);
  });

  it("T5: void destroy() logs teardown failures instead of leaking unhandled rejections (main-session path)", async () => {
    const { logger } = await import("../../src/kernel/logger.js");
    const runner = realRunner(async () => { throw new Error("main-session shutdown handler failed"); });
    const handle = handleWith(runner);
    handle.destroy(); // void entry — must not produce an unhandled rejection
    // no unhandledRejection by the time the teardown settles:
    let unhandled = false;
    const onUnhandled = () => { unhandled = true; };
    process.on("unhandledRejection", onUnhandled);
    try {
      await new Promise((r) => setTimeout(r, 60));
      expect(unhandled).toBe(false);
      expect((logger.error as any).mock.calls.some((c: any[]) => String(c[2]?.error ?? "").includes("teardown incomplete"))).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("T6: shutdownAll awaits every teardown settlement and aggregates failures; concurrent calls share one settlement", async () => {
    const { PiSdkRuntime } = await import("../../src/agent/runtime/pi-sdk.js");
    const rt = new PiSdkRuntime();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const good = handleWith(realRunner(async () => { await gate; })); // still tearing down
    const bad = handleWith(realRunner(async () => { throw new Error("shutdown boom"); }), () => { throw new Error("dispose boom"); });
    (rt as any).handles.set(good,"mem_good");
    (rt as any).handles.set(bad,"mem_bad");
    let settled = false;
    const mark = (p: Promise<void>) => p.then(() => { settled = true; }, () => { settled = true; });
    const p1 = rt.shutdownAll();
    const p2 = rt.shutdownAll(); // concurrent — must share the first settlement
    mark(p1); mark(p2);
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false); // waits for the gated teardown — not clear-and-return
    release?.();
    await Promise.allSettled([p1, p2]);
    expect(settled).toBe(true);
    // both concurrent callers observe the SAME failure outcome
    let failed1 = false; let failed2 = false;
    await p1.catch((e: any) => { failed1 = /teardown|shutdownAll/.test(e.message); });
    await p2.catch((e: any) => { failed2 = /teardown|shutdownAll/.test(e.message); });
    expect(failed1 && failed2).toBe(true);
    // A past failure must not turn a repeated shutdown into false success.
    await expect(rt.shutdownAll()).rejects.toThrow("incomplete");
    await expect(rt.shutdownMember("mem_bad")).rejects.toThrow("incomplete");
    await expect(rt.shutdownMember("mem_good")).resolves.toBeUndefined();
  });
});

it("teardown waits for manual compaction unwinding, not merely SDK agent idle", async()=>{
  const disposed=vi.fn();const handle=handleWith(realRunner(async()=>{}),disposed);
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  (handle as any).session.compact=vi.fn(async()=>{await gate;});
  const compact=handle.compact!();let settled=false;
  expect(fixture.db.get("SELECT status,operation FROM execution_attempts")).toEqual({status:"dispatched",operation:"external"});
  const teardown=handle.destroyAndWait!().then(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(settled).toBe(false);expect(disposed).not.toHaveBeenCalled();
  release();expect(await compact).toEqual({aborted:true});await teardown;
  expect(disposed).toHaveBeenCalledOnce();
  expect(fixture.db.get("SELECT status FROM execution_attempts")).toEqual({status:"interrupted"});
  await expect(handle.compact!()).rejects.toThrow("destroyed");
});
