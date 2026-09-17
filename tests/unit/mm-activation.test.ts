import { it, expect, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, createMockRoom, loginAndGetToken } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn } from "../helpers/mock-runtime.js";
import { getDatabase } from "../../src/data/database.js";
import { handleToolCallback } from "../../src/agent/tools/tools.js";
import { mmScopeIdOf } from "../../src/chat/conversations.js";
setupTestWorkspace();

// Batch 4 QA fix: the engine gate (`memberHasScopeAccess`) must accept pair
// members, and the receiver of a member↔member message must be activated
// through the normal delivery chain — not cancelled as "member unavailable".
it("activates the receiver of a member↔member message (mm scope)", async () => {
  const server = await createTestServer(); resetMocks();
  const token = await loginAndGetToken(server.port);
  try {
    const room = await createMockRoom(server.port, token, "MM Activation", ["alice", "bob"]);
    const [alice, bob] = room.globalMemberIds!;
    const scope = mmScopeIdOf(alice, bob);

    const sent = await handleToolCallback("chat_send", `dm:${alice}`, "alice", { to: bob, message: "ping bob" }, { memberId: alice });
    expect(sent).toMatchObject({ ok: true, chat: { id: scope, kind: "mm" } });

    // The receiver's runtime runs the pair-chat prompt.
    await vi.waitFor(() => expect(mockPromptFn).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const prompt = String(mockPromptFn.mock.calls[0][0] ?? "");
    expect(prompt).toContain("private chat with member");
    expect(prompt).toContain("ping bob");

    // The delivery was accepted for the pair scope — never skipped as unavailable.
    const rows = getDatabase().all<{ status: string; outcome: string | null; diagnosis: string | null }>(
      "SELECT status, outcome, diagnosis FROM queued_inputs WHERE scope_id=?", scope);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.diagnosis === "member unavailable")).toBe(false);
    expect(rows.some((r) => r.outcome === "not-dispatched")).toBe(false);
  } finally {
    await closeTestServer(server);
  }
});
