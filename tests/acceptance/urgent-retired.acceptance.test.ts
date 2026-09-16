/**
 * Acceptance: `!name` urgent gesture retired (fish #19455).
 *
 * - a WORKING target is never aborted by `!target`; no interrupt notice; the
 *   message stays in the room as plain text with no urgent snapshot fields
 * - the running turn settles normally and no interrupt follow-up turn appears
 * - idle target: `!name` alone stays inert; `@name` still activates as usual
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { Room } from "../../src/kernel/types.js";
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

import { resetMocks, setMockPromptFn, mockAbortFn } from "../helpers/mock-runtime.js";

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


describe("Acceptance: `!name` urgent gesture retired", () => {
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

  async function createRoom(name: string, members: string[]): Promise<Room> {
    return createMockRoom(ts.port, token, name, members);
  }

  async function sendMessage(roomId: string, content: string) {
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, { token, body: { content } });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  async function getMessages(roomId: string): Promise<any[]> {
    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${roomId}/messages?limit=100`, { token });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    return data.messages ?? data;
  }

  it("working target: `!pm` never aborts, posts no notice, stays plain text", async () => {
    const room = await createRoom("urgent-retired-working", ["pm"]);

    const promptCalls: string[] = [];
    let promptResolveFn: (() => void) | undefined;
    setMockPromptFn(async (msg: string) => {
      promptCalls.push(msg);
      await holdPrompt(resolve=>{promptResolveFn=resolve;});
    });

    const wsClient = await createWsClient(ts.wsUrl, token);
    wsClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    // 1) pm starts working on a long task
    await sendMessage(room.id, "@pm long task");
    await wsClient.waitFor(
      (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "working",
      3000,
    );
    expect(promptCalls).toHaveLength(1);

    // 2) retired gesture — the text is posted, but nothing interrupts
    await sendMessage(room.id, "!pm drop everything and reply");
    await new Promise((r) => setTimeout(r, 500));
    expect(mockAbortFn).not.toHaveBeenCalled();
    expect(promptCalls).toHaveLength(1);

    const msgs = await getMessages(room.id);
    const mine = msgs.find((m) => typeof m.content === "string" && m.content.includes("drop everything"));
    expect(mine).toBeTruthy();
    expect(mine.mentions ?? []).toEqual([]);
    expect(mine.urgentMentions).toBeUndefined();
    expect(mine.urgentMentionMemberIds).toBeUndefined();

    // 3) no interrupt notice for any message
    expect(msgs.some((m) => m.sender === "system" && /aborted by an urgent message/.test(m.content))).toBe(false);

    // 4) the running turn settles normally; no interrupt follow-up turn appears
    promptResolveFn!();
    await new Promise((r) => setTimeout(r, 200));
    expect(promptCalls).toHaveLength(1);

    await wsClient.close();
  });

  it("idle target: `!name` alone stays inert; `@name` still activates", async () => {
    const room = await createRoom("urgent-retired-idle", ["pm"]);

    const promptCalls: string[] = [];
    setMockPromptFn(async (msg: string) => {
      promptCalls.push(msg);
    });

    await sendMessage(room.id, "!pm quick question");
    await new Promise((r) => setTimeout(r, 400));
    expect(promptCalls).toHaveLength(0);
    expect(mockAbortFn).not.toHaveBeenCalled();

    await sendMessage(room.id, "@pm real question");
    await vi.waitFor(() => expect(promptCalls.length).toBe(1), { timeout: 3000 });
    expect(promptCalls[0]).toContain("real question");
    expect(promptCalls[0]).not.toContain("[INTERRUPTED]");
    expect(mockAbortFn).not.toHaveBeenCalled();
  });
});
