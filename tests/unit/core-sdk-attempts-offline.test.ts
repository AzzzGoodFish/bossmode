import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { coreFixture } from "../helpers/core-fixture.js";
import { PiSdkRuntime } from "../../src/engine/runtime/pi-sdk.js";
import type { RuntimePromptDispatch } from "../../src/engine/runtime/types.js";

// Real installed SDK, real SQL, and an explicitly injected in-process model runtime.
// No private SDK fields, provider/account access, sockets, or hand-written SDK history.
const mock = vi.hoisted(() => ({ root: "", modelRuntime: {} as any, onLoad: () => {} }));
vi.mock("../../src/kernel/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../src/config/config.js", () => ({ readConfig: () => ({}), getBossmodeDir: () => mock.root }));
vi.mock("../../src/member/member-extensions.js", () => ({ builtinMcpAdapterPath: () => mock.root, discoverMemberExtensionEntries: () => [] }));
vi.mock("../../src/files/layout.js", () => ({ memberSkillsDir: () => join(mock.root, "skills"), memberExtensionsDir: () => join(mock.root, "extensions") }));
vi.mock("../../src/shared/mcp-settings.js", () => ({
  ensureBossmodeMcpDirs: () => {}, getBossmodeMcpRuntimeDir: () => mock.root,
  writeMemberScopedMcpConfig: () => ({ configPath: join(mock.root, "unused-mcp.json"), serverNames: [], dispose() {} }),
}));
vi.mock("../../src/engine/runtime/bossmode-sdk-tools.js", () => ({ createBossmodeSdkTools: () => [] }));
vi.mock("../../src/engine/runtime/mcp-factory.js", () => ({ loadDatabaseMcpFactory: async () => ({
  name: "pi-mcp-adapter", factory: (pi: any) => {
    mock.onLoad();
    pi.registerFlag("mcp-config", { description: "Unused offline fixture", type: "string" });
    pi.registerTool({ name: "mcp", label: "Offline fixture", description: "Unused offline fixture", parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "offline" }], details: {} }) });
  },
}) }));
vi.mock("../../src/config/model-credentials.js", () => ({
  normalizeModelRef: (ref: string) => ref, resolvePiAgentDir: () => mock.root,
  exportPiConfigForMember: () => ({ agentDir: mock.root, profile: { id: "offline", providerSlug: "offline", authType: "api-key" } }),
  createDatabaseModelRuntime: async () => mock.modelRuntime, refreshDatabaseModelRuntime: async () => {}, getModelCredentialProfile: () => ({}),
}));
vi.mock("../../src/engine/runtime/model-credential-binding.js", () => ({ ModelCredentialBinding: class {
  attach() {} bind(model: unknown) { return model; } followSession() {}
} }));
let fixture: ReturnType<typeof coreFixture>;
let runtime: PiSdkRuntime;
let stream: ReturnType<typeof vi.fn>;
const owner = "mem_offline_sdk";
const model = { id: "model", name: "Offline model", provider: "offline", api: "offline", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 500000, maxTokens: 4096 };
function response(stopReason: "stop" | "error" | "aborted", text = "offline answer") {
  const events = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: "offline" as any, provider: "offline", model: "model", timestamp: Date.now(),
    stopReason, content: [{ type: "text", text }], ...(stopReason === "error" ? { errorMessage: "offline provider refusal" } : {}),
    usage: { input: 10, output: text ? 2 : 1, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  events.push({ type: "start", partial: message });
  if (stopReason === "stop") events.push({ type: "done", reason: "stop", message });
  else events.push({ type: "error", reason: stopReason, error: message });
  events.end();
  return events;
}
function rows() { return fixture.db.all<any>("SELECT * FROM execution_attempts ORDER BY rowid"); }
async function create() {
  return runtime.createAgent({ cwd: mock.root, roomId: "r", member: { id: owner, name: "Offline", model: "offline/model", credentialId: "offline" } as any,
    agentPrompt: "Offline test", skillPaths: [], roomMembers: [], callbacks: { onChat: async () => {}, onMention: async () => {} } });
}
beforeEach(() => {
  fixture = coreFixture(); mock.root = fixture.root; runtime = new PiSdkRuntime();
  fixture.db.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,'Offline','offline','test','{}',1,1)", owner);
  fixture.db.run("INSERT INTO scopes(id,kind,room_id) VALUES('r','room','r')");
  mock.onLoad = () => { expect(rows()[0]).toMatchObject({ operation: "session-create", status: "dispatched" }); fixture.db.assertOutsideTransaction(); };
  stream = vi.fn(() => { expect(rows().at(-1).status).toBe("dispatched"); fixture.db.assertOutsideTransaction(); return response("stop"); });
  mock.modelRuntime = {
    getModel: () => model, hasConfiguredAuth: () => true, isUsingOAuth: () => false,
    getAuth: async () => ({ auth: { apiKey: "offline-fixture-not-a-credential" } }),
    streamSimple: (...args: unknown[]) => stream(...args),
  };
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden in offline SDK test"); }));
});
afterEach(async () => { await runtime.shutdownAll(); vi.unstubAllGlobals(); fixture.close(); });

it("real SDK create, native prompt empty-retry, and successful settlement use distinct durable attempts", async () => {
  const h = await create(); const events: RuntimePromptDispatch[] = [];
  stream.mockImplementationOnce(() => response("stop", ""));
  await h.prompt("offline work", { beforeDispatch: event => { events.push(event); expect(rows().at(-1).id).toBe(event.attemptId); } });
  expect(events.map(e => e.dispatchIndex)).toEqual([0, 1]);
  expect(stream).toHaveBeenCalledTimes(2);
  expect(rows().map(r => [r.operation, r.status])).toEqual([["session-create", "acknowledged"], ["input", "acknowledged"], ["input", "acknowledged"]]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each(["error", "aborted"] as const)("real SDK resolves %s stream without falsely acknowledging the input", async reason => {
  const h = await create(); stream.mockImplementationOnce(() => response(reason));
  const observed: string[] = []; h.subscribe(event => { if (event.type === "message_end") observed.push(event.stopReason ?? ""); });
  await h.prompt("offline work");
  expect(observed).toContain(reason);
  expect(rows().at(-1)).toMatchObject({ operation: "input", status: "interrupted", diagnosis: expect.stringContaining(reason) });
  expect(stream).toHaveBeenCalledTimes(1);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("real SDK manual compaction failure is an external attempt, not an acknowledgement", async () => {
  const h = await create();
  await expect(h.compact()).rejects.toThrow(/Nothing to compact/);
  expect(rows().at(-1)).toMatchObject({ operation: "external", status: "interrupted", diagnosis: expect.stringContaining("Nothing to compact") });
  expect(stream).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("real SDK explicit Stop records interruption and waits for actual abort settlement", async () => {
  const h = await create();
  stream.mockImplementationOnce((_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
    const events = createAssistantMessageEventStream();
    const abort = () => {
      void response("aborted").result().then(message => {
        events.push({ type: "error", reason: "aborted", error: message });
        events.end();
      });
    };
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    return events;
  });
  const prompt = h.prompt("offline pending work");
  await vi.waitFor(() => expect(stream).toHaveBeenCalledTimes(1));
  h.abort();
  expect(rows().at(-1)).toMatchObject({ status: "interrupted", diagnosis: expect.stringContaining("abort requested") });
  await prompt;
  await h.waitForIdle();
  expect(rows().at(-1).status).toBe("interrupted");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
