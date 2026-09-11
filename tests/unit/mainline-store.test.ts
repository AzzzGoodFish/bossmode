import { coreFixture } from "../helpers/core-fixture.js";
import { SettingsRepository } from "../../src/storage/repositories/settings.js";
import { getDefaultConfig } from "../../src/shared/config.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tmpDir = process.env.BOSSMODE_DIR!;
let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => {
  fixture = coreFixture();
  new SettingsRepository(fixture.db).importConfig({ ...getDefaultConfig(), auth: { username: "fish", passwordHash: "fixture-only" } });
  new ConversationsRepository(fixture.db).upsertRoom({ id: "room-a", name: "Asset tests", createdAt: 1, members: [], roomMembers: [] });
});
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

const ACTOR = { type: "member" as const, memberId: "rm_1", name: "pm" };

async function seedRefs() {
  const { addMessage } = await import("../../src/workspace/message-store.js");
  mkdirSync(join(tmpDir, "memory", "projects", "bossmode"), { recursive: true });
  writeFileSync(join(tmpDir, "memory", "projects", "bossmode", "prd.md"), "# PRD", "utf-8");
  const message = addMessage("room-a", { sender: "user", content: "裁定", mentions: [] });
  return { message };
}

describe("mainline-store", () => {
  it("returns empty revision 0 for missing mainline", async () => {
    const { readMainline } = await import("../../src/workspace/mainline-store.js");
    const result = readMainline("room-a", "rm_1");
    expect(result.content).toBe("");
    expect(result.revision).toBe(0);
  });

  it("writes and reads back focus + index, with revision and history snapshot", async () => {
    const { writeMainline, readMainline, MAINLINE_TEMPLATE } = await import("../../src/workspace/mainline-store.js");
    expect(MAINLINE_TEMPLATE).toContain("## Focus");
    expect(MAINLINE_TEMPLATE).toContain("## Dynamic Index");
    const content = "## Focus\n\n产品理念 X。\n\n## Dynamic Index\n\n- docs/bossmode/prd.md — PRD\n";
    const saved = writeMainline({ roomId: "room-a", memberId: "rm_1", content, actor: ACTOR, reason: "0.19 kickoff" });
    expect(saved.revision).toBe(1);
    expect(readMainline("room-a", "rm_1").content).toBe(content);
    const { readFileSync } = await import("node:fs");
    const { listDocumentHistory } = await import("../../src/storage/document-repository.js");
    const history = listDocumentHistory(fixture.db, "rooms/room-a/memory/members/rm_1/mainline.md");
    expect(history).toHaveLength(1);
    expect(readFileSync(join(tmpDir, history[0].snapshotPath), "utf8")).toBe(content);
    expect(history[0]).toMatchObject({ reason: "0.19 kickoff", revision: 1, actorMemberId: "rm_1", actorName: "pm", operation: "write", snapshotBytes: Buffer.byteLength(content) });
    expect(readFileSync(join(tmpDir, "rooms/room-a/memory/members/rm_1/mainline.md"))).toEqual(Buffer.from(content));
    fixture.reopen();
    expect(readMainline("room-a", "rm_1")).toEqual(saved);
    expect(listDocumentHistory(fixture.db, "rooms/room-a/memory/members/rm_1/mainline.md")).toEqual(history);
  });

  it("requires reason and enforces the 4K budget with current content attached", async () => {
    const { writeMainline, MAINLINE_MAX_CHARS, AssetBudgetError } = await import("../../src/workspace/mainline-store.js");
    expect(MAINLINE_MAX_CHARS).toBe(4_000);
    expect(() => writeMainline({ roomId: "room-a", memberId: "rm_1", content: "x", actor: ACTOR, reason: "" })).toThrow(/reason is required/);
    writeMainline({ roomId: "room-a", memberId: "rm_1", content: "focus v1", actor: ACTOR, reason: "seed" });
    try {
      writeMainline({ roomId: "room-a", memberId: "rm_1", content: "y".repeat(4_001), actor: ACTOR, reason: "too big" });
      expect.unreachable();
    } catch (err: any) {
      expect(err).toBeInstanceOf(AssetBudgetError);
      expect(err.currentContent).toBe("focus v1");
    }
  });

  it("edits index entries via targeted text replacement", async () => {
    const { writeMainline, editMainline, readMainline } = await import("../../src/workspace/mainline-store.js");
    const content = `## Focus\n\nF\n\n## Dynamic Index\n\n- docs/bossmode/prd.md — PRD\n`;
    writeMainline({ roomId: "room-a", memberId: "rm_1", content, actor: ACTOR, reason: "pin" });
    const edited = editMainline({ roomId: "room-a", memberId: "rm_1", oldText: `- docs/bossmode/prd.md — PRD`, newText: "", actor: ACTOR, reason: "doc dropped" });
    expect(edited.content).not.toContain("prd.md");
    expect(readMainline("room-a", "rm_1").revision).toBe(2);
  });

  it("resolves docs/msg refs and marks unresolvable lines [stale] without deleting them", async () => {
    const { writeMainline, resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    const { message } = await seedRefs();
    const content = [
      "## Focus",
      "",
      "F",
      "",
      "## Dynamic Index",
      "",
      `- docs/bossmode/prd.md — PRD 存在`,
      `- docs/bossmode/gone.md — 已删除的文档`,
      `- msg:${message.id} — 消息存在(id 形式)`,
      `- msg:#10235 — 尚无 seq 的消息`,
      `- 每周五发版 — 非引用行不动`,
    ].join("\n");
    writeMainline({ roomId: "room-a", memberId: "rm_1", content, actor: ACTOR, reason: "pin" });
    const resolved = resolveMainlineRefs("room-a", content);
    expect(resolved).toContain("- docs/bossmode/prd.md — PRD 存在");
    expect(resolved).toContain("- [stale] docs/bossmode/gone.md — 已删除的文档");
    expect(resolved).toContain(`- msg:${message.id} — 消息存在(id 形式)`);
    expect(resolved).toContain("- [stale] msg:#10235 — 尚无 seq 的消息");
    expect(resolved).toContain("- 每周五发版 — 非引用行不动");
    // Focus section is never touched, even if it contains ref-looking text
    const withRefInFocus = `## Focus\n\n见 docs/bossmode/gone.md。\n\n## Dynamic Index\n\n- docs/bossmode/prd.md — ok\n`;
    const out = resolveMainlineRefs("room-a", withRefInFocus);
    expect(out).toContain("见 docs/bossmode/gone.md。");
    expect(out).not.toContain("[stale]");
  });

  it("msg:#<seq> resolves the SQL-allocated sequence without a JSONL rewrite", async () => {
    const { resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    const { addMessage } = await import("../../src/workspace/message-store.js");
    const message = addMessage("room-a", { sender: "user", content: "裁定", mentions: [] });
    expect(message.id).toBeTruthy();
    expect(message.seq).toBe(1);
    // A retained obsolete stream cannot override SQL sequence/message authority.
    mkdirSync(join(tmpDir, "rooms", "room-a"), { recursive: true });
    writeFileSync(join(tmpDir, "rooms", "room-a", "messages.jsonl"), JSON.stringify({ ...message, seq: 7 }) + "\n");
    const content = `## Dynamic Index\n\n- msg:#${message.seq} — 有 seq 的消息\n`;
    const resolved = resolveMainlineRefs("room-a", content);
    expect(resolved).toContain(`- msg:#${message.seq} — 有 seq 的消息`);
    expect(resolved).not.toContain("[stale]");
    expect(resolveMainlineRefs("room-a", "## Dynamic Index\n- msg:#7 — obsolete sequence")).toContain("[stale]");
  });

  it("re-resolution is idempotent and self-healing (stale mark dropped when target returns)", async () => {
    const { resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    const staleOnce = resolveMainlineRefs("room-a", "## Dynamic Index\n\n- docs/bossmode/later.md — 稍后创建\n");
    expect(staleOnce).toContain("[stale]");
    // A second read must not double-mark
    const staleTwice = resolveMainlineRefs("room-a", staleOnce);
    expect(staleTwice.match(/\[stale\]/g)).toHaveLength(1);
    // Target appears → stale mark dropped on next read
    mkdirSync(join(tmpDir, "memory", "projects", "bossmode"), { recursive: true });
    writeFileSync(join(tmpDir, "memory", "projects", "bossmode", "later.md"), "x", "utf-8");
    const healed = resolveMainlineRefs("room-a", staleTwice);
    expect(healed).not.toContain("[stale]");
    expect(healed).toContain("- docs/bossmode/later.md — 稍后创建");
  });

  it("parseMainline returns structured focus + index with kind/ref/note/stale", async () => {
    const { parseMainline, resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    mkdirSync(join(tmpDir, "memory", "projects", "bossmode"), { recursive: true });
    writeFileSync(join(tmpDir, "memory", "projects", "bossmode", "prd.md"), "# PRD", "utf-8");
    const content = [
      "## Focus",
      "",
      "产品理念 X。",
      "第二行。",
      "",
      "## Dynamic Index",
      "",
      "- docs/bossmode/prd.md — PRD 文档",
      "- [stale] docs/bossmode/gone.md — 已删",
      "- 每周五发版 — 非引用行",
      "- docs/bossmode/nonote.md",
      "",
      "## 其它",
      "",
      "- docs/bossmode/ignored.md — 不在索引区",
    ].join("\n");
    const parsed = parseMainline(content);
    expect(parsed.focus).toBe("产品理念 X。\n第二行。");
    expect(parsed.index).toHaveLength(4);
    expect(parsed.index[0]).toMatchObject({ kind: "doc", ref: "docs/bossmode/prd.md", note: "PRD 文档", stale: false });
    expect(parsed.index[1]).toMatchObject({ kind: "doc", ref: "docs/bossmode/gone.md", note: "已删", stale: true });
    expect(parsed.index[2]).toMatchObject({ kind: "other", ref: "", note: "每周五发版 — 非引用行" });
    expect(parsed.index[3]).toMatchObject({ kind: "doc", ref: "docs/bossmode/nonote.md", note: "" });
    // parse of stale-resolved content matches resolve+parse round trip
    const resolved = resolveMainlineRefs("room-a", content);
    expect(parseMainline(resolved).index[0].stale).toBe(false);
    // empty content → empty view
    expect(parseMainline("")).toEqual({ focus: "", index: [] });
    expect(parseMainline("## Focus\n\n\n\n## Dynamic Index\n")).toEqual({ focus: "", index: [] });
  });
});
