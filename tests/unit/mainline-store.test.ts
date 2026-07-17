import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-mainline-"));
  mkdirSync(join(tmpDir, "rooms", "room-a"), { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

const ACTOR = { type: "member" as const, memberId: "rm_1", name: "pm" };

async function seedRefs() {
  const { addMessage } = await import("../../src/workspace/message-store.js");
  const { createTask } = await import("../../src/workspace/task-store.js");
  mkdirSync(join(tmpDir, "knowledge", "docs", "bossmode"), { recursive: true });
  writeFileSync(join(tmpDir, "knowledge", "docs", "bossmode", "prd.md"), "# PRD", "utf-8");
  const task = createTask("room-a", { title: "版本主任务", createdBy: "pm" });
  const message = addMessage("room-a", { sender: "user", content: "裁定", mentions: [] });
  return { task, message };
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
    expect(MAINLINE_TEMPLATE).toContain("## 焦点");
    expect(MAINLINE_TEMPLATE).toContain("## 动态索引");
    const content = "## 焦点\n\n产品理念 X。\n\n## 动态索引\n\n- docs/bossmode/prd.md — PRD\n";
    const saved = writeMainline({ roomId: "room-a", memberId: "rm_1", content, actor: ACTOR, reason: "0.19 kickoff" });
    expect(saved.revision).toBe(1);
    expect(readMainline("room-a", "rm_1").content).toBe(content);
    const { readFileSync } = await import("node:fs");
    const history = readFileSync(join(tmpDir, "rooms", "room-a", "mainlines", "history.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe(content);
    expect(history[0].reason).toBe("0.19 kickoff");
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
    const { task } = await seedRefs();
    const content = `## 焦点\n\nF\n\n## 动态索引\n\n- task:${task.id} — 主任务\n`;
    writeMainline({ roomId: "room-a", memberId: "rm_1", content, actor: ACTOR, reason: "pin" });
    const edited = editMainline({ roomId: "room-a", memberId: "rm_1", oldText: `- task:${task.id} — 主任务`, newText: "", actor: ACTOR, reason: "task done" });
    expect(edited.content).not.toContain(task.id);
    expect(readMainline("room-a", "rm_1").revision).toBe(2);
  });

  it("resolves docs/task/msg refs and marks unresolvable lines [stale] without deleting them", async () => {
    const { writeMainline, resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    const { task, message } = await seedRefs();
    const content = [
      "## 焦点",
      "",
      "F",
      "",
      "## 动态索引",
      "",
      `- docs/bossmode/prd.md — PRD 存在`,
      `- docs/bossmode/gone.md — 已删除的文档`,
      `- task:${task.id} — 任务存在`,
      `- task:task-deadbeef — 不存在的任务`,
      `- msg:${message.id} — 消息存在(id 形式)`,
      `- msg:#10235 — 尚无 seq 的消息`,
      `- 每周五发版 — 非引用行不动`,
    ].join("\n");
    writeMainline({ roomId: "room-a", memberId: "rm_1", content, actor: ACTOR, reason: "pin" });
    const resolved = resolveMainlineRefs("room-a", content);
    expect(resolved).toContain("- docs/bossmode/prd.md — PRD 存在");
    expect(resolved).toContain("- [stale] docs/bossmode/gone.md — 已删除的文档");
    expect(resolved).toContain(`- task:${task.id} — 任务存在`);
    expect(resolved).toContain("- [stale] task:task-deadbeef — 不存在的任务");
    expect(resolved).toContain(`- msg:${message.id} — 消息存在(id 形式)`);
    expect(resolved).toContain("- [stale] msg:#10235 — 尚无 seq 的消息");
    expect(resolved).toContain("- 每周五发版 — 非引用行不动");
    // Focus section is never touched, even if it contains ref-looking text
    const withRefInFocus = `## 焦点\n\n见 docs/bossmode/gone.md。\n\n## 动态索引\n\n- docs/bossmode/prd.md — ok\n`;
    const out = resolveMainlineRefs("room-a", withRefInFocus);
    expect(out).toContain("见 docs/bossmode/gone.md。");
    expect(out).not.toContain("[stale]");
  });

  it("msg:#<seq> resolves once messages carry seq (stream 1 merged)", async () => {
    const { writeMainline, resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    const { addMessage } = await import("../../src/workspace/message-store.js");
    const message = addMessage("room-a", { sender: "user", content: "裁定", mentions: [] });
    // Simulate the post-stream-1 shape: messages carry a seq field
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    const path = join(tmpDir, "rooms", "room-a", "messages.jsonl");
    const lines = readFileSync(path, "utf-8").trim().split("\n").map((l) => ({ ...JSON.parse(l), seq: 7 }));
    write(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf-8");
    expect(message.id).toBeTruthy();
    const content = `## 动态索引\n\n- msg:#7 — 有 seq 的消息\n`;
    const resolved = resolveMainlineRefs("room-a", content);
    expect(resolved).toContain("- msg:#7 — 有 seq 的消息");
    expect(resolved).not.toContain("[stale]");
  });

  it("re-resolution is idempotent and self-healing (stale mark dropped when target returns)", async () => {
    const { resolveMainlineRefs } = await import("../../src/workspace/mainline-store.js");
    const staleOnce = resolveMainlineRefs("room-a", "## 动态索引\n\n- docs/bossmode/later.md — 稍后创建\n");
    expect(staleOnce).toContain("[stale]");
    // A second read must not double-mark
    const staleTwice = resolveMainlineRefs("room-a", staleOnce);
    expect(staleTwice.match(/\[stale\]/g)).toHaveLength(1);
    // Target appears → stale mark dropped on next read
    mkdirSync(join(tmpDir, "knowledge", "docs", "bossmode"), { recursive: true });
    writeFileSync(join(tmpDir, "knowledge", "docs", "bossmode", "later.md"), "x", "utf-8");
    const healed = resolveMainlineRefs("room-a", staleTwice);
    expect(healed).not.toContain("[stale]");
    expect(healed).toContain("- docs/bossmode/later.md — 稍后创建");
  });
});
