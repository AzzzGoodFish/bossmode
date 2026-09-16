/**
 * Acceptance Tests: Member State Machine v1 (0.8.7)
 *
 * Coverage:
 * - SM-1: INACTIVE → WORKING → IDLE transitions emit agent:status WS events
 * - SM-2: agentStatuses in room detail reflects current state
 * - SM-3: Activating WORKING agent routes to steer (manager uses instance.status)
 * - SM-4: Compact fire-and-forget: sendCommand used, no sendRequest timeout
 * - SM-5: Summarizer timeout protection (SUMMARIZER_TIMEOUT_MS = 300_000)
 * - SM-6: isWorking removed from AgentHandle interface
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { Room, RoomMessage } from "../../src/kernel/types.js";
import {
  setupTestWorkspace,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  createMockRoom,
} from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";

import { resetMocks, setMockPromptFn } from "../helpers/mock-runtime.js";

// setupTestWorkspace must be called at module level (before server imports)
setupTestWorkspace();
const heldPrompts = new Set<() => void>();
function holdPrompt(assign: (finish:()=>void)=>void): Promise<void> {
  return new Promise<void>(resolve=>{
    const finish=()=>{heldPrompts.delete(finish);resolve();};
    heldPrompts.add(finish);assign(finish);
  });
}
afterEach(()=>{
  // A fake provider must actually finish its held calls before runtime teardown.
  // Later queued turns use the already-completed fake, never another hidden gate.
  setMockPromptFn(async()=>{});
  for(const finish of [...heldPrompts])finish();
});


describe("Acceptance: Member State Machine (0.8.7)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function createRoom(name: string, members: string[] = ["pm"]): Promise<Room> {
    return createMockRoom(ts.port, token, name, members);
  }

  async function sendMessage(roomId: string, content: string): Promise<RoomMessage> {
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, {
      token,
      body: { content },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  // ── SM-1: State transition WS events ────────────────────────────────────

  it("SM-1: WORKING and IDLE agent:status WS events fire on activation and completion", async () => {
    const room = await createRoom("sm1-transitions", ["pm"]);

    const wsClient = await createWsClient(ts.wsUrl, token);
    wsClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    let promptResolveFn: (() => void) | undefined;
    setMockPromptFn(async () => {
      await holdPrompt(resolve=>{promptResolveFn=resolve;});
    });

    // Activate agent → WORKING
    await sendMessage(room.id, "@pm please work on this");

    const workingEvent = await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "working",
      3000,
    );
    expect(workingEvent).toBeTruthy();
    expect((workingEvent as any).roomId).toBe(room.id);

    // Release prompt → IDLE
    promptResolveFn!();

    const idleEvent = await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "idle",
      3000,
    );
    expect(idleEvent).toBeTruthy();

    await wsClient.close();
  });

  // ── SM-2: agentStatuses in room detail ──────────────────────────────────

  it("SM-2: room agentStatuses reflects WORKING and IDLE states", async () => {
    const room = await createRoom("sm2-agentstatus", ["pm"]);

    const wsClient = await createWsClient(ts.wsUrl, token);
    wsClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    let promptResolveFn: (() => void) | undefined;
    setMockPromptFn(async () => {
      await holdPrompt(resolve=>{promptResolveFn=resolve;});
    });

    await sendMessage(room.id, "@pm hold");

    // Wait for WORKING
    await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "working",
      3000,
    );

    // Room detail and room list should show working
    const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
    const roomData = JSON.parse(roomRes.body);
    expect(roomData.agentStatuses).toBeDefined();
    expect(roomData.agentStatuses.pm).toBe("working");

    const roomsRes = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
    const roomsData = JSON.parse(roomsRes.body);
    const listedRoom = roomsData.find((r: any) => r.id === room.id);
    expect(listedRoom?.agentStatuses?.pm).toBe("working");

    // Release → IDLE
    promptResolveFn!();
    await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "idle",
      3000,
    );

    const roomRes2 = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
    const roomData2 = JSON.parse(roomRes2.body);
    expect(roomData2.agentStatuses.pm).toBe("idle");

    const roomsRes2 = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
    const roomsData2 = JSON.parse(roomsRes2.body);
    const listedRoom2 = roomsData2.find((r: any) => r.id === room.id);
    expect(listedRoom2?.agentStatuses?.pm).toBe("idle");

    await wsClient.close();
  });

  // ── SM-3: WORKING agent activation routes to steer ──────────────────────

  it("SM-3: Second activation while WORKING calls steer, not prompt again", async () => {
    const room = await createRoom("sm3-steer-routing", ["pm"]);

    const promptCalls: string[] = [];
    let promptResolveFn: (() => void) | undefined;

    setMockPromptFn(async (msg: string) => {
      promptCalls.push(msg);
      await holdPrompt(resolve=>{promptResolveFn=resolve;});
    });

    const wsClient = await createWsClient(ts.wsUrl, token);
    wsClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    // First activation — prompt called, now WORKING
    await sendMessage(room.id, "@pm first task");
    await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "working",
      3000,
    );

    expect(promptCalls).toHaveLength(1);

    // Second activation while WORKING — should steer, not call prompt again
    await sendMessage(room.id, "@pm another task while working");
    await new Promise((r) => setTimeout(r, 300));

    // prompt should NOT be called a second time
    expect(promptCalls).toHaveLength(1);

    // Release
    promptResolveFn!();

    await wsClient.close();
  });

  // ── SM-5: Summarizer removed in 0.19.0 ─────────────────────────────────

  it("SM-5: write_summary tool and summarize routes are gone", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const tools = readFileSync(join(process.cwd(), "src/agent/tools/tools.ts"), "utf-8");
    const sdk = readFileSync(join(process.cwd(), "src/agent/runtime/bossmode-sdk-tools.ts"), "utf-8");
    expect(tools).not.toContain('case "write_summary"');
    expect(sdk).not.toContain('name: "write_summary"');
  });

  // ── SM-6: isWorking removed from AgentHandle ──────────────────────────

  it("SM-6: AgentHandle interface does not declare isWorking property", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/agent/runtime/types.ts"), "utf-8");

    // Find the AgentHandle interface block
    const ifaceStart = src.indexOf("interface AgentHandle");
    expect(ifaceStart).toBeGreaterThan(-1);

    // Find closing brace of the interface
    let depth = 0;
    let ifaceEnd = ifaceStart;
    for (let i = ifaceStart; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) { ifaceEnd = i; break; }
      }
    }
    const iface = src.slice(ifaceStart, ifaceEnd + 1);

    // isWorking must not be a declared property in the interface
    expect(iface).not.toContain("isWorking");
  });
});
