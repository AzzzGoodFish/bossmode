/**
 * 体验批② backend — mainline msg refs enriched with msgId + summary, and DM
 * scope msg refs finally resolve (previously readAllMessages on the phantom
 * rooms/dm:<id> dir → every DM msg ref was stale).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

function seedAgent(name: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n---\n\nYou are ${name}.\n`, "utf-8");
}

const MAINLINE = `## Focus
Ship the 0.20 flagship.

## Dynamic Index
- task:task-abc123 — flagship task
- msg:#42 — the decision message
- msg:msg_live_1 — direct id ref
- msg:#999 — long gone
- docs/bossmode/design/term.md — glossary
`;

describe("mainline msg ref enrichment (room + DM scope)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-msgref-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    seedAgent("architect");
    vi.resetModules();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("room scope: msg entries get msgId + summary; stale entries stay bare", async () => {
    const { addMessage } = await import("../../src/workspace/message-store.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("r", dir, [], undefined);
    // message-bus append uses seq from the room store
    const m42 = addMessage(room.id, { sender: "architect", content: "We decided to ship the unified panel", mentions: [] } as any);
    const m43 = addMessage(room.id, { sender: "user", content: "go ahead", mentions: [] } as any);
    const m44 = addMessage(room.id, { sender: "architect", content: "done", mentions: [] } as any);

    const ml = await import("../../src/workspace/mainline-store.js");
    // Rewrite the mainline so msg:#42 points at the actual seq of m42
    const content = `## Focus\nShip.\n\n## Dynamic Index\n- task:task-abc123 — flagship task\n- msg:#${m42.seq} — the decision message\n- msg:${m44.id} — direct id ref\n- msg:#999 — long gone\n`;
    const messages = ml.loadScopeMessages(room.id);
    const resolved = ml.resolveMainlineRefs(room.id, content, messages);
    const parsed = ml.parseMainline(resolved, ml.buildMsgLookup(messages));

    const msgEntry = parsed.index.find((e) => e.kind === "msg" && e.ref === `msg:#${m42.seq}`)!;
    expect(msgEntry.stale).toBe(false);
    expect(msgEntry.msgId).toBe(m42.id);
    expect(msgEntry.summary).toContain("unified panel");

    const idEntry = parsed.index.find((e) => e.kind === "msg" && e.ref === `msg:${m44.id}`)!;
    expect(idEntry.msgId).toBe(m44.id);

    const staleEntry = parsed.index.find((e) => e.kind === "msg" && e.ref === "msg:#999")!;
    expect(staleEntry.stale).toBe(true);
    expect(staleEntry.msgId).toBeUndefined();
  });

  it("DM scope: msg refs resolve against the member-owned DM stream", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const dm = await import("../../src/workspace/dm-message-store.js");
    const arch = reg.createMember({ name: "architect", agentTemplate: "architect" });
    const msg = dm.addDmMessage(arch.id, { sender: "user", content: "remember this DM decision", mentions: [] } as any);

    const ml = await import("../../src/workspace/mainline-store.js");
    const scopeKey = `dm:${arch.id}`;
    const content = `## Focus\nX\n\n## Dynamic Index\n- msg:#${msg.seq} — dm decision\n`;
    const messages = ml.loadScopeMessages(scopeKey);
    expect(messages.length).toBe(1);

    const resolved = ml.resolveMainlineRefs(scopeKey, content, messages);
    const parsed = ml.parseMainline(resolved, ml.buildMsgLookup(messages));
    const entry = parsed.index.find((e) => e.kind === "msg")!;
    expect(entry.stale).toBe(false);
    expect(entry.msgId).toBe(msg.id);
    expect(entry.summary).toContain("DM decision");
  });
});
