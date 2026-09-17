import { getDefaultConfig, writeConfig } from "../../src/config/settings.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { coreFixture } from "../helpers/core-fixture.js";


import { createMember } from "../../src/app/member-actions.js";
import { createRoom, inviteGlobalMember } from "../../src/chat/conversations.js";
import { addMessage } from "../../src/chat/message-store.js";
import { handleToolCallback } from "../../src/agent/tools/tools.js";
import { renderQueryRowsForMember, type QueryRow } from "../../src/agent/tools/query-render.js";

// Parent-owned tools.ts applies member visibility to rows, but not reply targets.
// Keep these desired-behavior regressions separate from the 44 modernized cases.
describe.each(["room", "dm"] as const)("hidden reply target in %s", kind => {
  let fixture: ReturnType<typeof coreFixture>;
  let rows: QueryRow[];
  let inline: string;
  let file: string;
  const hidden = "USER-ONLY SYSTEM NOTICE: do not expose this through a quote";

  beforeEach(async () => {
    fixture = coreFixture();
    writeConfig(getDefaultConfig(), fixture.db);
    const member = createMember({ name: "reader" });
    const room = createRoom("Visibility", undefined, []);
    inviteGlobalMember(room.id, { id: member.id, name: member.name });
    const scope = kind === "room" ? room.id : `dm:${member.id}`;
    const target = addMessage(scope, { sender: "system", content: hidden, mentions: [] });
    addMessage(scope, { sender: "user", content: "Visible reply", mentions: [], replyTo: { messageId: target.id, seq: target.seq! } });
    rows = await handleToolCallback("chat_read", scope, member.id, {}) as QueryRow[];
    inline = renderQueryRowsForMember(rows);
    const result = await handleToolCallback("chat_read", scope, member.id, { output: "file" }) as { path: string };
    try { file = readFileSync(result.path, "utf8"); }
    finally { rmSync(result.path); }
  });
  afterEach(() => fixture.close());

  it("omits the hidden notice as a row and renders the visible reply in both output modes", () => {
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("Visible reply");
    expect(inline).toContain("Visible reply");
    expect(file).toContain(inline);
  });

  // Verified red on base 097792b in /tmp/bm-core-assets-finish-defects-red.log.
  // Remove .fails with the parent tools.ts visibility fix; an unexpected pass fails this gate.
  it("does not expose a hidden target through inline or file reply excerpts", () => {
    expect({ inline, file }).toEqual({
      inline: expect.not.stringContaining(hidden),
      file: expect.not.stringContaining(hidden),
    });
    expect(rows[0].replyTo).toMatchObject({ unavailable: true });
  });
});
