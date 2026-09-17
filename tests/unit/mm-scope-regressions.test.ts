import { loadMemberPromptSource } from "../../src/app/member-actions.js";
import { it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestWorkspace } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn, MockAgentHandle } from "../helpers/mock-runtime.js";
setupTestWorkspace();

// ── 2026-09-16 (lhy) regressions: member↔member chats (mm) ─────────────────
// Two shipped-0.26.0 bugs found in the wild:
//   1) every bossmode tool was denied while the caller's current chat was the
//      pair scope — the tool dispatcher wrapped `mm:…` as `room:mm:…` for the
//      membership pre-check (tools.toolScopeId).
//   2) a member whose instance was born in a pair chat crashed on its next
//      message batch after any profile rename — `refreshProfileSources` read
//      `.kind` off a null parse of the `mm:` scope (agent-manager).

it("regression: a pair member's tools work while the caller's own chat is the member chat", async () => {
  const reg = await import("../../src/member/identity.js"), __reg_app_member_actions = await import("../../src/app/member-actions.js");
  const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
  const ref = await import("../../src/chat/conversations.js");
  const alice = __reg_app_member_actions.createMember({ name: "alice" });
  const bob = __reg_app_member_actions.createMember({ name: "bob" });
  const scope = ref.mmScopeIdOf(alice.id, bob.id);

  // Open the chat (alice → bob), then act from *inside* it: the runtime passes
  // the pair scope itself as the tool call's chat id.
  const opened = await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "ping" }, { memberId: alice.id }) as any;
  expect(opened).toMatchObject({ ok: true, chat: { id: scope, kind: "mm" } });

  const listed = await handleToolCallback("chat_list", scope, alice.id, {}, { memberId: alice.id }) as any;
  expect(listed.ok).toBe(true);
  expect(listed.chats.some((c: any) => c.id === scope)).toBe(true);

  const sent = await handleToolCallback("chat_send", scope, alice.id, { to: bob.id, message: "from inside" }, { memberId: alice.id }) as any;
  expect(sent).toMatchObject({ ok: true, chat: { id: scope } });

  // Outsiders stay denied — the fix must not weaken the pair check.
  const carol = __reg_app_member_actions.createMember({ name: "carol" });
  const denied = await handleToolCallback("chat_list", scope, carol.id, {}, { memberId: carol.id }) as any;
  expect(denied.ok).toBe(false);
});

it("regression: a rename does not crash the next batch of an instance born in a pair chat", async () => {
  resetMocks();
  const suffix = randomUUID().slice(0, 6);
  const reg = await import("../../src/member/identity.js"), __reg_app_member_actions = await import("../../src/app/member-actions.js");
  const manager = await import("../../src/agent/orchestrator/agent-manager.js");
  const { RuntimeRegistry } = await import("../../src/agent/runtime/registry.js");
  const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
  const { mmScopeIdOf } = await import("../../src/chat/conversations.js");
  const { updateProfileForMember } = await import("../../src/member/profile.js");
  const { getDatabase } = await import("../../src/data/database.js");

  const alice = __reg_app_member_actions.createMember({ name: `alice-${suffix}`, agentTemplate: "developer", model: "mock-model", credentialId: "cred-test" });
  const bob = __reg_app_member_actions.createMember({ name: `bob-${suffix}`, agentTemplate: "developer", model: "mock-model", credentialId: "cred-test" });
  const scope = mmScopeIdOf(alice.id, bob.id);
  const handles: any[] = [];
  const runtime = {
    name: "pi-cli",
    capabilities: {},
    shutdownAll: async () => {},
    createAgent: vi.fn(async () => {
      const handle = new MockAgentHandle() as any;
      handle.refreshPrompt = vi.fn();
      handles.push(handle);
      return handle;
    }),
  };
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime as any);
  manager.initAgentManager(runtimes, loadMemberPromptSource);
  const stopRouter = manager.wireMentionRouter();
  try {
    // First message: bob is activated and his instance is born in the pair scope.
    const opened = await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "ping" }, { memberId: alice.id }) as any;
    expect(opened).toMatchObject({ ok: true, chat: { id: scope, kind: "mm" } });
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(manager.getAgentInstanceForScope(scope, bob.id)?.scopeId).toBe(scope);

    // Any committed profile change marks every live instance for prompt refresh.
    updateProfileForMember(alice.id, { name: `alice2-${suffix}` });

    // The next message must dispatch — pre-fix this batch threw
    // "Cannot read properties of null (reading 'kind')" and never reached the model.
    const second = await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "ping2" }, { memberId: alice.id }) as any;
    expect(second).toMatchObject({ ok: true, chat: { id: scope } });
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(handles[0]?.refreshPrompt).toHaveBeenCalled();

    const errors = getDatabase().all<{ content: string }>(
      "SELECT content FROM messages WHERE content LIKE ?", "%Cannot read properties of null%");
    expect(errors).toHaveLength(0);
  } finally {
    stopRouter();
    await manager.shutdownAll();
  }
});
