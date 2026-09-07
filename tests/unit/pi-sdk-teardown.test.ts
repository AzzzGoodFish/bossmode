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
import { describe, expect, it, vi } from "vitest";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

vi.mock("../../src/workspace/extension-store.js", () => ({
  resolveMemberExtensionPaths: () => [],
  resolveMemberExtensionSkillPaths: () => [],
}));
vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PiSdkAgentHandle } from "../../src/engine/runtime/pi-sdk.js";

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
    [],
    [],
    { model: "test/m", thinkingLevel: "off" },
    [],
    { roomId: "room:t", agentName: "t", roomMembers: ["t"] },
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
});
