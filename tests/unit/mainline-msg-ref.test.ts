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

  it("loose msg forms resolve: No.n / #n / msg:n all map to seq; non-ref prose stays 'other'", async () => {
    const { addMessage } = await import("../../src/workspace/message-store.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("r2", dir, [], undefined);
    const m1 = addMessage(room.id, { sender: "architect", content: "loose ref message", mentions: [] } as any);
    const m2 = addMessage(room.id, { sender: "user", content: "another one", mentions: [] } as any);

    const ml = await import("../../src/workspace/mainline-store.js");
    const content = `## Focus\nShip.\n\n## Dynamic Index\n- No.${m1.seq} 附近 — natural language, capital No.\n- #${m2.seq} — bare hash\n- msg:${m1.seq} 这里 — numeric msg:\n- 11:44 那份 — time, must NOT become a ref\n- #abc — not digits, must NOT become a ref\n- No.abc — not digits, must NOT become a ref\n`;
    const messages = ml.loadScopeMessages(room.id);
    const resolved = ml.resolveMainlineRefs(room.id, content, messages);
    const parsed = ml.parseMainline(resolved, ml.buildMsgLookup(messages));

    const noEntry = parsed.index.find((e) => e.ref === `No.${m1.seq}`)!;
    expect(noEntry.kind).toBe("msg");
    expect(noEntry.stale).toBe(false);
    expect(noEntry.msgId).toBe(m1.id);

    const hashEntry = parsed.index.find((e) => e.ref === `#${m2.seq}`)!;
    expect(hashEntry.kind).toBe("msg");
    expect(hashEntry.msgId).toBe(m2.id);

    const msgNumericEntry = parsed.index.find((e) => e.ref === `msg:${m1.seq}`)!;
    expect(msgNumericEntry.kind).toBe("msg");
    expect(msgNumericEntry.msgId).toBe(m1.id);

    // Non-ref prose lines stay 'other' (never misread as a reference).
    const others = parsed.index.filter((e) => e.kind === "other");
    expect(others).toHaveLength(3);
    expect(others.some((e) => e.note.includes("11:44"))).toBe(true);
    expect(others.some((e) => e.note.includes("#abc"))).toBe(true);
    expect(others.some((e) => e.note.includes("No.abc"))).toBe(true);
  });

  it("loose forms in Focus text are never parsed as references (index-context only)", async () => {
    const ml = await import("../../src/workspace/mainline-store.js");
    const content = `## Focus\nRemember No.14502 and #88 — prose, not refs.\n\n## Dynamic Index\n- task:task-x — t\n`;
    const parsed = ml.parseMainline(content);
    expect(parsed.index.some((e) => e.kind === "msg")).toBe(false);
  });
});
