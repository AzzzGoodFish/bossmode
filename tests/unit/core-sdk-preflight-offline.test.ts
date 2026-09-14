import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import {
  createAgentSession, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, createAssistantMessageEventStream, Type, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { BossmodeResourceLoader, PiSdkAgentHandle } from "../../src/engine/runtime/pi-sdk.js";
import { coreFixture } from "../helpers/core-fixture.js";

vi.mock("../../src/foundation/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// All SDK/ModelRuntime/extension/provider/agent-loop objects are real. Only the
// registered provider and tool perform fake, synchronous, counted offline work.
const owner = "mem_preflight";
const provider = "offline-preflight";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
let fixture: ReturnType<typeof coreFixture>;
let entered: ReturnType<typeof gate>;
let release: ReturnType<typeof gate>;
let handles: PiSdkAgentHandle[];
let sessions: AgentSession[];
let providerCalls: Array<{ aborted: boolean }>;
let toolCalls: number;
let unwound: boolean;
let shutdownCalls: number;
let blockEvent: "before_agent_start" | "input" | "agent_start";
let extensionErrors: unknown[];

function response(tool: boolean): ReturnType<typeof createAssistantMessageEventStream> {
  const events = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", api: "offline-preflight" as any, provider, model: "fake", timestamp: Date.now(),
    stopReason: tool ? "toolUse" : "stop",
    content: tool ? [{ type: "toolCall", id: "count-1", name: "count_effect", arguments: {} }] : [{ type: "text", text: "offline answer" }],
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  events.push({ type: "start", partial: message });
  events.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
  events.end();
  return events;
}
function rows() { return fixture.db.all<any>("SELECT * FROM execution_attempts ORDER BY rowid"); }
async function create(wrapped = true) {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerProvider(provider, {
    baseUrl: "https://offline.invalid", api: "offline-preflight", apiKey: "offline-not-a-credential",
    models: [{ id: "fake", name: "Offline fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 500000, maxTokens: 4096 }],
    streamSimple: (_model: unknown, context: any, options?: SimpleStreamOptions) => {
      providerCalls.push({ aborted: options?.signal?.aborted ?? false });
      // Deliberately ignores cancellation to prove that the provider callback
      // itself is never entered by the fixed adapter, not merely cooperative.
      return response(context.messages.at(-1)?.role !== "toolResult");
    },
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new BossmodeResourceLoader({
    cwd: fixture.root, agentDir: join(fixture.root, "pi-private"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "offline-barrier", factory: (pi: ExtensionAPI) => {
      let blocked = false;
      const block = async () => {
        if (blocked) return;
        blocked = true;
        entered.release();
        try { await release.promise; } finally { unwound = true; }
      };
      pi.on(blockEvent as "before_agent_start", block);
      pi.on("session_shutdown", async () => { shutdownCalls++; expect(unwound).toBe(true); });
      pi.registerTool({ name: "count_effect", label: "Count offline effect", description: "Count an offline test effect",
        parameters: Type.Object({}), execute: async () => {
          toolCalls++;
          return { content: [{ type: "text", text: "counted" }], details: {} };
        } });
    } }],
  }, { systemPrompt: "Offline test", appendSystemPrompt: [] });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.root, agentDir: join(fixture.root, "pi-private"), modelRuntime,
    model: modelRuntime.getModel(provider, "fake"), resourceLoader: loader, settingsManager: settings,
    sessionManager: SessionManager.create(fixture.root, join(fixture.root, "sdk-sessions")), tools: ["count_effect"],
  });
  sessions.push(session);
  await session.bindExtensions({ mode: "print", onError: error => extensionErrors.push(error) });
  if (!wrapped) return { session, handle: undefined! as PiSdkAgentHandle };
  const handle = new PiSdkAgentHandle(session, new ModelRegistry(modelRuntime), {} as any, loader, settings,
    [], [], { model: `${provider}/fake` }, [], { memberId: owner, roomId: "r", agentName: "Preflight", roomMembers: [] });
  handles.push(handle);
  return { session, handle };
}

beforeEach(() => {
  fixture = coreFixture(); entered = gate(); release = gate(); handles = []; sessions = [];
  providerCalls = []; toolCalls = 0; unwound = false; shutdownCalls = 0; extensionErrors = [];
  blockEvent = "before_agent_start";
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,'Preflight','preflight','test','{}',1,1)", owner);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('r','room','r')");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in offline preflight test"); }));
});
afterEach(async () => {
  release.release();
  try {
    await Promise.all(handles.map(handle => handle.destroyAndWait()));
    for (const session of sessions) { await session.abort(); session.dispose(); }
    expect(extensionErrors).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); fixture.close(); }
});

it.each([false, true])("real SDK control: preflight abort, re-abort at agent_start=%s", async reabort => {
  const { session } = await create(false);
  if (reabort) session.subscribe(event => { if (event.type === "agent_start") session.agent.abort(); });
  const pending = session.prompt("offline control");
  await entered.promise;
  expect(session.agent.signal).toBeUndefined();
  await session.abort();
  expect(unwound).toBe(false);
  release.release();
  await pending;
  if (!reabort) {
    // No re-abort: the turn proceeds normally once the preflight barrier releases.
    expect(providerCalls.length).toBeGreaterThan(0);
    expect(providerCalls[0].aborted).toBe(false);
    expect(toolCalls).toBe(1);
  } else {
    // pi >=0.85: an abort that lands before the model request starts is honored during
    // auth resolution (prepareRequest now forwards the run signal to getAuth), so the
    // provider callback is never entered and the turn settles as an aborted request error.
    // (0.82 and earlier still entered the provider here, with an already-aborted signal.)
    expect(providerCalls).toEqual([]);
    expect(toolCalls).toBe(0);
    const lastMessageEntry = session.sessionManager.getBranch()
      .filter(entry => entry.type === "message")
      .at(-1) as { message: { role: string; stopReason?: string; errorMessage?: string } };
    expect(lastMessageEntry.message.role).toBe("assistant");
    expect(lastMessageEntry.message.stopReason).toBe("error");
    expect(lastMessageEntry.message.errorMessage).toBe("This operation was aborted");
  }
});

it.each(["before_agent_start", "input", "agent_start"] as const)("Stop during real %s barrier prevents native provider/tool work and preserves a later prompt", async event => {
  blockEvent = event;
  const { handle, session } = await create();
  const receipts: string[] = [];
  handle.subscribe(event => { if (event.type === "message_end") receipts.push(event.stopReason ?? ""); });
  const pending = handle.prompt("cancel this work");
  await entered.promise;
  handle.abort();
  const attemptId = rows()[0].id;
  expect(rows()[0]).toMatchObject({ operation: "input", status: "interrupted" });
  let idle = false;
  const idleWait = handle.waitForIdle().then(() => { idle = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(idle).toBe(false);
  expect(unwound).toBe(false);
  await expect(handle.prompt("overlap")).rejects.toThrow(/already in progress/);
  release.release();
  await pending;
  await idleWait;
  expect(unwound).toBe(true);
  expect(providerCalls).toEqual([]);
  expect(toolCalls).toBe(0);
  expect(receipts).toEqual(["aborted"]);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toMatchObject({ id: attemptId, status: "interrupted" });
  expect(session.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted")).toBe(true);

  await handle.prompt("legitimate fresh work");
  expect(providerCalls).toEqual([{ aborted: false }, { aborted: false }]);
  expect(toolCalls).toBe(1);
  expect(rows().map(row => row.status)).toEqual(["interrupted", "acknowledged"]);
});

it("preserveCompaction still cancels pending prompt preflight without poisoning a fresh prompt", async () => {
  const { handle } = await create();
  const pending = handle.prompt("cancel preflight only");
  await entered.promise;
  handle.abort({ preserveCompaction: true });
  release.release();
  await pending;
  expect(providerCalls).toEqual([]);
  expect(toolCalls).toBe(0);
  expect(rows()[0].status).toBe("interrupted");
  await handle.prompt("fresh work");
  expect(providerCalls).toEqual([{ aborted: false }, { aborted: false }]);
  expect(toolCalls).toBe(1);
  expect(rows().map(row => row.status)).toEqual(["interrupted", "acknowledged"]);
});

it("Stop from a public agent_start listener also prevents the first provider call", async () => {
  const { handle } = await create();
  handle.subscribe(event => { if (event.type === "agent_start") handle.abort(); });
  const pending = handle.prompt("stop on start");
  await entered.promise;
  release.release();
  await pending;
  expect(providerCalls).toEqual([]);
  expect(toolCalls).toBe(0);
  expect(rows()[0].status).toBe("interrupted");
});

it("teardown waits for preflight unwinding before extension shutdown and SDK disposal", async () => {
  const { handle } = await create();
  const pending = handle.prompt("teardown during preflight");
  await entered.promise;
  let destroyed = false;
  const teardown = handle.destroyAndWait().then(() => { destroyed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(destroyed).toBe(false);
  expect(shutdownCalls).toBe(0);
  expect(rows()[0].status).toBe("interrupted");
  release.release();
  await pending;
  await teardown;
  expect(shutdownCalls).toBe(1);
  expect(providerCalls).toEqual([]);
  expect(toolCalls).toBe(0);
  await expect(handle.prompt("not reusable after teardown")).rejects.toThrow(/destroyed/);
});

it("Stop in a synchronous dispatch hook retains cancellation through real SDK preflight", async () => {
  const { handle } = await create();
  const pending = handle.prompt("cancel at SQL handoff", { beforeDispatch: () => handle.abort() });
  await entered.promise;
  expect(rows()[0].status).toBe("interrupted");
  release.release();
  await pending;
  expect(providerCalls).toEqual([]);
  expect(toolCalls).toBe(0);
  expect(rows()[0].status).toBe("interrupted");
});
