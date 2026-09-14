import { describe, expect, it, vi } from "vitest";
import { MEMBER_DIRECT_TOOL_NAMES, MEMBER_GATEWAY_TOOL_NAMES } from "../../src/shared/member-tool-names.js";
import { setupTestWorkspace } from "../helpers/test-server.js";

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

setupTestWorkspace();

const unknownMessage = async (tool: string): Promise<string> => {
  const { handleToolCallback } = await import("../../src/engine/tools.js");
  try {
    // No trusted member context: the call lands on the dispatcher default (an
    // unknown name never reaches a store) and must throw the guided error.
    await handleToolCallback(tool, "room-unknown", "pm", {});
    throw new Error("expected an unknown-tool rejection");
  } catch (error) {
    return (error as Error).message;
  }
};

/** "available: a, b, c. Gateway capabilities (…)" → [a, b, c] */
const availableNames = (message: string): string[] =>
  message.split("available: ")[1]!.split(". ")[0]!.split(", ");

describe("unknown tool guidance", () => {
  it("names the canonical surface instead of a bare error", async () => {
    const message = await unknownMessage("chat");
    expect(message).toContain('Unknown tool "chat"');
    expect(availableNames(message)).toEqual([...MEMBER_DIRECT_TOOL_NAMES]);
    for (const capability of MEMBER_GATEWAY_TOOL_NAMES) expect(message).toContain(capability);
    expect(message).toContain('{action:"call", tool:"<name>", args:{…}}');
    // qm-style guidance only — no retired-name mapping table.
    expect(message).not.toContain("→");
    expect(message).not.toContain("->");
  });

  it("never offers a retired tool name as available", async () => {
    // `wait` stays excluded here: its dispatcher branch lives until the
    // member-level batch removes the runtime (it is unregistered from the
    // surface but still answers). Every name below is gone from the surface.
    for (const retired of ["chat", "query_room_messages", "list_scopes", "member_status", "update_profile", "create_room", "edit_room", "list_members"]) {
      const message = await unknownMessage(retired);
      expect(message.startsWith(`Unknown tool "${retired}"`)).toBe(true);
      expect(availableNames(message)).not.toContain(retired);
    }
  });

  it("keeps the SDK registration and the canonical name lists in lockstep", async () => {
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const tools = createBossmodeSdkTools({ roomId: "r1", memberId: "mem_drift_fixture" });
    expect(tools.map((tool) => tool.name)).toEqual([...MEMBER_DIRECT_TOOL_NAMES]);

    const gateway = tools.find((tool) => tool.name === "bossmode")!;
    const listed = (await (gateway.execute as any)("g", { action: "list" })).content[0].text as string;
    for (const capability of MEMBER_GATEWAY_TOOL_NAMES) expect(listed).toContain(capability);
  });
});
