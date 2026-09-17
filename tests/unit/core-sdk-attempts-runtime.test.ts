
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { coreFixture } from "../helpers/core-fixture.js";
import { openDatabase } from "../../src/data/database.js";
import { PiSdkAgentHandle, PiSdkRuntime } from "../../src/agent/runtime/pi-sdk.js";
import type { CreateAgentOpts, RuntimePromptDispatch } from "../../src/agent/types.js";

const mock = vi.hoisted(() => ({
  stage: vi.fn(), create: vi.fn(), reload: vi.fn(), configDispose: vi.fn(),
  root: "", hosted: true,
}));
vi.mock("../../src/kernel/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../src/config/settings.js", () => ({
  readConfig: () => ({})
}));
vi.mock("../../src/member/extensions.js", () => ({
  builtinMcpAdapterPath: () => mock.root,
  discoverMemberExtensionEntries: () => { mock.stage("extensions"); return []; },
}));
vi.mock("../../src/files/layout.js", () => ({ memberSkillsDir: () => join(mock.root, "skills"), memberExtensionsDir: () => join(mock.root, "extensions") }));
vi.mock("../../src/member/mcp.js", () => ({
  ensureBossmodeMcpDirs: () => {}, getBossmodeMcpRuntimeDir: () => mock.root,
  writeMemberScopedMcpConfig: () => ({ configPath: join(mock.root, "mcp.json"), serverNames: [], dispose: mock.configDispose }),
}));
vi.mock("../../src/agent/runtime/mcp-factory.js", () => ({ loadDatabaseMcpFactory: async () => { mock.stage("mcp factory"); return {}; } }));
vi.mock("../../src/agent/runtime/tools.js", () => ({ createBossmodeSdkTools: () => [] }));
vi.mock("../../src/config/models.js", () => ({
  getModelCredentialProfile: () => ({}),
}));
vi.mock("../../src/config/pi-adapt/credentials.js", () => ({
  normalizeModelRef: (ref: string) => ref,
  resolvePiAgentDir: () => mock.root,
  exportPiConfigForMember: () => { mock.stage("credentials"); return { agentDir: mock.root, profile: { id: "p", providerSlug: "mock", authType: "api-key" } }; },
  createDatabaseModelRuntime: async () => { mock.stage("model runtime"); return {}; },
  refreshDatabaseModelRuntime: async () => {},
}));
vi.mock("../../src/agent/runtime/model-credential-binding.js", () => ({ ModelCredentialBinding: class {
  attach() {} bind(model: unknown) { return model; } followSession() {}
} }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "mock-sdk",
  DefaultResourceLoader: class {
    constructor() { mock.stage("loader constructor"); }
    async reload() { mock.stage("loader reload"); await mock.reload(); }
    getExtensions() { return { extensions: mock.hosted ? [{ path: "<inline:pi-mcp-adapter>", tools: new Map([["mcp", {}]]) }] : [] }; }
  },
  ModelRegistry: class {
    constructor() { mock.stage("registry"); }
    find(provider: string, id: string) { return { provider, id }; }
    async getApiKeyAndHeaders() { return { ok: true, apiKey: "offline" }; }
  },
  SettingsManager: { create: () => ({
    applyOverrides() {}, getTransport: () => "auto", getWebSocketConnectTimeoutMs: () => 15000,
    getHttpIdleTimeoutMs: () => undefined,
  }) },
  SessionManager: { create: () => { mock.stage("session manager"); return {}; } },
  createAgentSession: (...args: unknown[]) => { mock.stage("create session"); return mock.create(...args); },
}));

let fixture: ReturnType<typeof coreFixture>;
let runtime: PiSdkRuntime;
let session: ReturnType<typeof makeSession>;
let handles: PiSdkAgentHandle[];
const owner = "mem_sdk_owner";
function rows() { return fixture.db.all<any>("SELECT * FROM execution_attempts ORDER BY rowid"); }
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeSession() {
  const listeners = new Set<(event: any) => void>();
  return {
    sessionId: "sdk-public-id", sessionFile: undefined,
    model: { provider: "mock", id: "model", contextWindow: 500000 },
    settingsManager: { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384 }) },
    subscribe: vi.fn((fn: (event: any) => void) => { listeners.add(fn); return () => listeners.delete(fn); }),
    emit: (event: any) => { for (const fn of listeners) fn(event); },
    prompt: vi.fn(async (_message: string, _opts: unknown) => {}), compact: vi.fn(async () => ({})),
    abort: vi.fn(async () => {}), abortCompaction: vi.fn(), abortBranchSummary: vi.fn(),
    dispose: vi.fn(), bindExtensions: vi.fn(async () => {}),
    extensionRunner: { setFlagValue: vi.fn(), hasHandlers: () => false },
    reload: vi.fn(async () => {}), getActiveToolNames: () => ["read", "mcp"], setActiveToolsByName: vi.fn(),
  };
}
function handle(scopeId = "r", memberId = owner) {
  const h = new PiSdkAgentHandle(session as any, {} as any, {} as any,
    { setPromptSources: vi.fn(), setResourcePaths: vi.fn() } as any, {}, [], { roomId: scopeId, memberId, agentName: "SDK owner", roomMembers: [] });
  handles.push(h);
  return h;
}
function opts(scopeId = "r", memberId = owner): CreateAgentOpts {
  return { cwd: mock.root, roomId: scopeId, member: { id: memberId, name: "SDK owner", model: "mock/model", credentialId: "p" } as any,
    agentPrompt: "test", skillPaths: [], roomMembers: [], callbacks: { onChat: async () => {}, onMention: async () => {} } };
}
function assistant(stopReason: string, text = "answer", tokens = 10, tools = false) {
  session.emit({ type: "message_end", message: { role: "assistant", stopReason,
    content: tools ? [{ type: "toolCall", name: "read" }] : [{ type: "text", text }], usage: { totalTokens: tokens, output: text ? 2 : 1 } } });
}
beforeEach(() => {
  vi.clearAllMocks(); mock.hosted = true; mock.stage.mockReset(); mock.reload.mockReset(); mock.configDispose.mockReset();
  fixture = coreFixture(); mock.root = fixture.root;
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,'SDK owner','sdk owner','test','{}',1,1)", owner);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('r','room','r')");
  fixture.db.run("INSERT INTO scopes(id,kind,member_id) VALUES(?,'dm',?)", `dm:${owner}`, owner);
  session = makeSession(); handles = []; runtime = new PiSdkRuntime();
  mock.create.mockReset().mockResolvedValue({ session });
});
afterEach(async () => {
  await Promise.allSettled(handles.map(h => h.destroyAndWait()));
  await runtime.shutdownAll().catch(() => {});
  fixture.close();
});

describe("actual prompt dispatches", () => {
  it("commits each initial and empty-retry dispatch with parent SQL hook, before SDK IO", async () => {
    const h = handle(); const events: RuntimePromptDispatch[] = [];
    fixture.db.exec("CREATE TABLE parent_inputs(attempt_id TEXT, dispatch_index INTEGER, message TEXT)");
    const observer = openDatabase(fixture.path);
    try {
      session.prompt.mockImplementation(async () => {
        fixture.db.assertOutsideTransaction();
        const committed = observer.all<any>("SELECT * FROM execution_attempts ORDER BY rowid");
        expect(committed.at(-1).status).toBe("dispatched");
        expect(observer.all("SELECT * FROM parent_inputs")).toHaveLength(committed.length);
        assistant("stop", committed.length === 1 ? "" : "answer");
      });
      await h.prompt("initial", { beforeDispatch: event => {
        events.push({ ...event });
        expect(() => fixture.db.assertOutsideTransaction()).toThrow(/enclosing/);
        expect(rows().at(-1)).toMatchObject({ id: event.attemptId, status: "dispatched" });
        fixture.db.run("INSERT INTO parent_inputs VALUES(?,?,?)", event.attemptId, event.dispatchIndex, event.message);
      } });
      expect(events.map(e => e.dispatchIndex)).toEqual([0, 1]);
      expect(events[1].message).toMatch(/previous response came back empty/);
      expect(session.prompt.mock.calls.map(c => c[0])).toEqual(events.map(e => e.message));
      expect(rows().map(r => r.status)).toEqual(["acknowledged", "acknowledged"]);
      session.prompt.mockImplementation(async () => {});
      await h.prompt("next", { beforeDispatch: e => { expect(e.dispatchIndex).toBe(0); } });
      expect(rows()).toHaveLength(3);
    } finally { observer.close(); }
  });

  it("records watchdog abort, explicit compact, and continuation separately", async () => {
    const h = handle(); const events: RuntimePromptDispatch[] = [];
    session.prompt.mockImplementation(async () => { assistant("stop", "answer", 470000, session.prompt.mock.calls.length === 1); });
    session.compact.mockImplementation(async () => {
      expect(rows().at(-1)).toMatchObject({ operation: "external", status: "dispatched", external_reference: "pi-sdk:session.compact" });
      return {};
    });
    await h.prompt("work", { beforeDispatch: e => { events.push(e); } });
    expect(events.map(e => e.dispatchIndex)).toEqual([0, 1]);
    expect(events[1].message).toMatch(/automatically compacted/);
    expect(rows().map(r => [r.operation, r.status])).toEqual([["input", "interrupted"], ["external", "acknowledged"], ["input", "acknowledged"]]);
    expect(rows()[0].diagnosis).toMatch(/watchdog.*not replayed/);
  });

  it("does not acknowledge a resolved provider-error or aborted stream", async () => {
    const h = handle();
    for (const reason of ["error", "aborted"]) {
      session.prompt.mockImplementationOnce(async () => { assistant(reason); });
      await h.prompt(reason);
      expect(rows().at(-1)).toMatchObject({ status: "interrupted", diagnosis: expect.stringContaining(reason) });
    }
  });

  it("does not let a later successful stream erase earlier provider failure evidence", async () => {
    session.prompt.mockImplementationOnce(async () => { assistant("error"); assistant("stop"); });
    await handle().prompt("work");
    expect(rows()[0].status).toBe("interrupted");
  });

  it("records rejected and synchronously thrown SDK calls without replay", async () => {
    const h = handle();
    session.prompt.mockRejectedValueOnce(new Error("provider failed"));
    await expect(h.prompt("work")).rejects.toThrow("provider failed");
    session.prompt.mockImplementationOnce(() => { throw new Error("synchronous failure"); });
    await expect(h.prompt("work")).rejects.toThrow("synchronous failure");
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(rows().map(r => r.status)).toEqual(["interrupted", "interrupted"]);
  });

  it.each(["throw", "promise", "async", "sql"])("rolls back %s hooks and never calls SDK", async mode => {
    fixture.db.exec("CREATE TABLE hook_effect(value TEXT)");
    if (mode === "sql") fixture.db.exec("CREATE TRIGGER reject_dispatch BEFORE UPDATE ON execution_attempts BEGIN SELECT RAISE(ABORT,'dispatch SQL failure'); END");
    const h = handle();
    const beforeDispatch = mode === "async" ? async () => {} : () => {
      fixture.db.run("INSERT INTO hook_effect VALUES('claimed')");
      if (mode === "throw") throw new Error("hook failure");
      if (mode === "promise") return Promise.reject(new Error("async rejection"));
    };
    await expect(h.prompt("work", { beforeDispatch })).rejects.toThrow(/hook failure|synchronous|dispatch SQL failure/);
    expect(session.prompt).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(fixture.db.all("SELECT * FROM hook_effect")).toEqual([]);
    if (mode === "sql") fixture.db.exec("DROP TRIGGER reject_dispatch");
    await h.prompt("fresh"); // No leaked prompt/watchdog lock after failed admission.
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("failed continuation admission does not undo a settled prior SDK attempt", async () => {
    session.prompt.mockImplementationOnce(async () => { assistant("stop", ""); });
    await expect(handle().prompt("work", { beforeDispatch: e => { if (e.dispatchIndex === 1) throw new Error("continuation admission failed"); } })).rejects.toThrow(/continuation admission/);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(rows().map(r => r.status)).toEqual(["acknowledged"]);
  });

  it("an encompassing empty-response failure leaves two individually settled SDK attempts", async () => {
    session.prompt.mockImplementation(async () => { assistant("stop", ""); });
    await expect(handle().prompt("work")).rejects.toThrow(/empty response twice/);
    expect(rows().map(r => r.status)).toEqual(["acknowledged", "acknowledged"]);
  });

  it("cancellation records uncertainty while pending; late resolution cannot acknowledge", async () => {
    const pending = deferred(); const h = handle();
    session.prompt.mockImplementationOnce(() => pending.promise);
    const run = h.prompt("work");
    h.abort();
    expect(rows()[0].status).toBe("interrupted");
    expect(session.abort).toHaveBeenCalledTimes(1);
    pending.resolve(); await run;
    expect(rows()[0]).toMatchObject({ status: "interrupted", diagnosis: expect.stringContaining("abort requested") });
  });

  it.each(["r", "room:r", `dm:${owner}`])("requires and preserves real SQL ownership for %s", async scope => {
    await handle(scope).prompt("private child or live input");
    expect(rows()[0]).toMatchObject({ member_id: owner, scope_id: scope === "room:r" ? "r" : scope });
  });

  it.each([["r", "SDK owner"], ["r", ""], ["missing", owner], [`dm:${owner}`, "mem_other"]])("rejects invalid owner %s/%s without SDK IO", async (scope, member) => {
    fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_other','Other','other','test','{}',1,1)");
    await expect(handle(scope, member).prompt("work")).rejects.toThrow(/member ID|scope_not_found|belong/);
    expect(session.prompt).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it("refuses uninitialized storage without SDK IO", async () => {
    const h = handle(); fixture.db.close();
    await expect(h.prompt("work")).rejects.toThrow(/not initialized/);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("propagates acknowledgement SQL failure and keeps uncertain evidence", async () => {
    fixture.db.exec("CREATE TRIGGER reject_ack BEFORE UPDATE ON execution_attempts WHEN NEW.status='acknowledged' BEGIN SELECT RAISE(ABORT,'ack SQL failure'); END");
    await expect(handle().prompt("work")).rejects.toThrow(/ack SQL failure/);
    expect(rows()[0]).toMatchObject({ status: "interrupted", diagnosis: expect.stringContaining("ack SQL failure") });
  });
});

describe("compaction and cleanup boundaries", () => {
  it("records manual compaction before IO and only acknowledges after settlement", async () => {
    const pending = deferred<any>(); session.compact.mockImplementationOnce(() => pending.promise);
    const run = handle().compact();
    expect(rows()[0]).toMatchObject({ operation: "external", status: "dispatched" });
    pending.resolve({}); await expect(run).resolves.toEqual({ aborted: false });
    expect(rows()[0].status).toBe("acknowledged");
  });

  it("teardown waits for manual compact settlement, including after recording cancellation", async () => {
    const pending = deferred<any>(); const h = handle();
    session.compact.mockImplementationOnce(() => pending.promise);
    const compact = h.compact(); const stop = h.destroyAndWait();
    await Promise.resolve(); await Promise.resolve();
    expect(rows()[0].status).toBe("interrupted");
    expect(session.dispose).not.toHaveBeenCalled();
    pending.resolve({}); await expect(compact).resolves.toEqual({ aborted: true });
    await stop; expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("manual compact SQL admission failure is not swallowed by concurrent teardown", async () => {
    fixture.db.exec("CREATE TRIGGER reject_compact BEFORE INSERT ON execution_attempts BEGIN SELECT RAISE(ABORT,'compact admission failed'); END");
    const h = handle(); const compact = h.compact();
    const failure = expect(compact).rejects.toThrow(/compact admission failed/);
    await h.destroyAndWait(); await failure;
    expect(session.compact).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it("manual compact interruption SQL failure propagates after still cancelling SDK work", async () => {
    const pending = deferred<any>(); const h = handle();
    session.compact.mockImplementationOnce(() => pending.promise);
    const compact = h.compact();
    fixture.db.exec("CREATE TRIGGER reject_interrupt BEFORE UPDATE ON execution_attempts WHEN NEW.status='interrupted' BEGIN SELECT RAISE(ABORT,'interrupt SQL failure'); END");
    h.abort(); expect(session.abortCompaction).toHaveBeenCalledTimes(1);
    pending.reject(new Error("SDK cancelled"));
    await expect(compact).rejects.toThrow(/execution recording failed/);
    expect(rows()[0].status).toBe("dispatched"); // No fabricated terminal evidence when storage rejects it.
  });

  it("records manual compaction cancellation even when the SDK resolves", async () => {
    const pending = deferred<any>(); const h = handle(); session.compact.mockImplementationOnce(() => pending.promise);
    const run = h.compact(); h.abort(); pending.resolve({});
    await expect(run).resolves.toEqual({ aborted: true });
    expect(rows()[0].status).toBe("interrupted");
  });

  it("preserveCompaction does not interrupt a manual compact attempt", async () => {
    const pending = deferred<any>(); const h = handle(); session.compact.mockImplementationOnce(() => pending.promise);
    const run = h.compact(); h.abort({ preserveCompaction: true }); pending.resolve({});
    await expect(run).resolves.toEqual({ aborted: false });
    expect(rows()[0].status).toBe("acknowledged");
  });

  it("records compaction stream failure despite resolved promise", async () => {
    session.compact.mockImplementationOnce(async () => { session.emit({ type: "compaction_end", reason: "manual", aborted: true, errorMessage: "summary provider failed" }); return {}; });
    await expect(handle().compact()).resolves.toEqual({ aborted: true });
    expect(rows()[0]).toMatchObject({ status: "interrupted", diagnosis: expect.stringContaining("summary provider failed") });
  });

  it("keeps benign watchdog compact rejection interrupted while allowing the existing continuation", async () => {
    session.prompt.mockImplementation(async () => { assistant("stop", "answer", 470000, session.prompt.mock.calls.length === 1); });
    session.compact.mockRejectedValueOnce(new Error("Nothing to compact"));
    await handle().prompt("work");
    expect(rows().map(r => r.status)).toEqual(["interrupted", "interrupted", "acknowledged"]);
  });

  it("teardown waits for prompt quiescence and retains failed cleanup", async () => {
    const h = handle(); const pending = deferred();
    session.prompt.mockImplementationOnce(() => pending.promise);
    const run = h.prompt("work");
    let disposed = false; session.dispose.mockImplementation(() => { disposed = true; throw new Error("cleanup failed"); });
    const teardown = h.destroyAndWait(); const rejection = expect(teardown).rejects.toThrow(/cleanup failed/);
    await Promise.resolve(); expect(disposed).toBe(false); expect(rows()[0].status).toBe("interrupted");
    pending.resolve(); await run; await rejection;
    await expect(h.destroyAndWait()).rejects.toThrow(/cleanup failed/);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    await expect(h.prompt("later")).rejects.toThrow(/destroyed/);
  });
});

describe("whole session creation", () => {
  it("dispatches before credentials, extensions, loader, or session creation; awaits binding", async () => {
    const pending = deferred(); session.bindExtensions.mockImplementationOnce(() => pending.promise);
    mock.stage.mockImplementation(() => {
      fixture.db.assertOutsideTransaction();
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ operation: "session-create", status: "dispatched", member_id: owner, scope_id: "r" });
    });
    const creation = runtime.createAgent(opts());
    await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalled());
    expect(rows()[0].status).toBe("dispatched");
    pending.resolve(); const h = await creation;
    expect(rows()[0].status).toBe("acknowledged");
    await h.prompt("standalone child");
    expect(rows().map(r => r.operation)).toEqual(["session-create", "input"]);
    await runtime.shutdownMember(owner); expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(rows()[0].status).toBe("acknowledged"); // Teardown does not undo successful creation.
  });

  it("rejects absent SQL owner before any resource activity", async () => {
    await expect(runtime.createAgent(opts("r", "missing"))).rejects.toThrow(/member ID/);
    expect(mock.stage).not.toHaveBeenCalled(); expect(mock.create).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it("rejects creation SQL failure before any resource activity", async () => {
    fixture.db.exec("CREATE TRIGGER reject_create BEFORE INSERT ON execution_attempts BEGIN SELECT RAISE(ABORT,'create SQL failure'); END");
    await expect(runtime.createAgent(opts())).rejects.toThrow(/create SQL failure/);
    expect(mock.stage).not.toHaveBeenCalled(); expect(rows()).toEqual([]);
  });

  it.each(["credentials", "model runtime", "session manager", "extensions", "loader constructor", "loader reload", "create session"])("records early %s failure without a leaked dispatched attempt", async stage => {
    mock.stage.mockImplementation(current => { if (current === stage) throw new Error(`failed ${stage}`); });
    await expect(runtime.createAgent(opts())).rejects.toThrow(`failed ${stage}`);
    expect(rows()[0]).toMatchObject({ status: "interrupted", diagnosis: expect.stringContaining(`failed ${stage}`) });
    expect(session.dispose).not.toHaveBeenCalled();
    await runtime.shutdownAll();
  });

  it("waits for creation-failure cleanup and retains failed teardown across shutdown calls", async () => {
    const abort = deferred();
    session.bindExtensions.mockRejectedValueOnce(new Error("bind failed"));
    session.abort.mockImplementationOnce(() => abort.promise);
    session.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
    const creation = runtime.createAgent(opts()); const rejection = expect(creation).rejects.toThrow(/creation and cleanup failed/);
    await vi.waitFor(() => expect(session.abort).toHaveBeenCalled());
    expect(rows()[0].status).toBe("dispatched");
    abort.resolve(); await rejection;
    expect(rows()[0].status).toBe("interrupted");
    expect(mock.configDispose).toHaveBeenCalledTimes(1);
    await expect(runtime.shutdownMember(owner)).rejects.toThrow(/teardown incomplete/);
    await expect(runtime.shutdownAll()).rejects.toThrow(/teardown/);
    await expect(runtime.shutdownAll()).rejects.toThrow(/teardown/);
  });

  it("cleans up a created handle when SQL acknowledgement fails", async () => {
    fixture.db.exec("CREATE TRIGGER reject_ack BEFORE UPDATE ON execution_attempts WHEN NEW.status='acknowledged' BEGIN SELECT RAISE(ABORT,'ack failed'); END");
    await expect(runtime.createAgent(opts())).rejects.toThrow(/ack failed/);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(mock.configDispose).toHaveBeenCalledTimes(1);
    expect(rows()[0].status).toBe("interrupted");
    await runtime.shutdownAll(); expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("retains resource cleanup failure even before an SDK session is obtained", async () => {
    mock.reload.mockRejectedValueOnce(new Error("extension load failed"));
    mock.configDispose.mockImplementation(() => { throw new Error("config cleanup failed"); });
    await expect(runtime.createAgent(opts())).rejects.toThrow(/creation and cleanup failed/);
    expect(rows()[0].status).toBe("interrupted");
    await expect(runtime.shutdownMember(owner)).rejects.toThrow(/teardown incomplete/);
    expect(mock.create).not.toHaveBeenCalled();
  });
});
