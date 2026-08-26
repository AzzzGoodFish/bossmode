import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-ka-test-"));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
}));

function ensureRoom(roomId: string, extra: Record<string, unknown> = {}) {
  const dir = join(tmpDir, "rooms", roomId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "room.json"), JSON.stringify({
    id: roomId, name: `Room ${roomId}`, cwd: "/tmp", members: ["architect"], createdAt: Date.now(), ...extra,
  }), "utf-8");
}

function writeDoc(relPath: string, content: string): string {
  const abs = join(tmpDir, "memory", "projects", relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
  return abs;
}

async function getRoomMessages(roomId: string) {
  const messageStore = await import("../../src/workspace/message-store.js");
  return messageStore.getMessages(roomId);
}

describe("knowledge-activity", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { _resetDedup } = await import("../../src/engine/knowledge-activity.js");
    _resetDedup();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("emits a knowledge_event card for write tool inside docs root without parsing frontmatter", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k1");
    const abs = writeDoc("proj/arch.md", "---\ntitle: 架构总览\n---\n\n# 架构\n内容");
    maybeEmitKnowledgeActivity("k1", "architect", "write", { path: abs }, false, "/tmp");

    const messages = await getRoomMessages("k1");
    const card = messages.find((m) => m.type === "knowledge_event");
    expect(card).toBeTruthy();
    expect(card!.knowledge_event_meta?.path).toBe("proj/arch.md");
    expect(card!.knowledge_event_meta?.title).toBe("架构");
    expect(card!.knowledge_event_meta?.actor).toBe("architect");
  });

  it("falls back to first heading then filename for title", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k2");
    const abs = writeDoc("proj/no-fm.md", "# Heading Title\n\nbody");
    maybeEmitKnowledgeActivity("k2", "pm", "edit", { path: abs }, false, "/tmp");
    const messages = await getRoomMessages("k2");
    expect(messages.find((m) => m.type === "knowledge_event")!.knowledge_event_meta?.title).toBe("Heading Title");
  });

  it("ignores writes outside docs root", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k3");
    maybeEmitKnowledgeActivity("k3", "dev", "write", { path: "/tmp/some-code.ts" }, false, "/tmp");
    const messages = await getRoomMessages("k3");
    expect(messages.find((m) => m.type === "knowledge_event")).toBeUndefined();
  });

  it("ignores non-write tools and errored calls", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k4");
    const abs = writeDoc("proj/x.md", "# X");
    maybeEmitKnowledgeActivity("k4", "dev", "bash", { command: `echo hi > ${abs}` }, false, "/tmp");
    maybeEmitKnowledgeActivity("k4", "dev", "write", { path: abs }, true, "/tmp");
    const messages = await getRoomMessages("k4");
    expect(messages.find((m) => m.type === "knowledge_event")).toBeUndefined();
  });

  it("dedups repeated writes to the same doc within the window", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k5");
    const abs = writeDoc("proj/repeat.md", "# R");
    maybeEmitKnowledgeActivity("k5", "dev", "write", { path: abs }, false, "/tmp");
    maybeEmitKnowledgeActivity("k5", "dev", "edit", { path: abs }, false, "/tmp");
    maybeEmitKnowledgeActivity("k5", "dev", "write", { path: abs }, false, "/tmp");
    const messages = await getRoomMessages("k5");
    expect(messages.filter((m) => m.type === "knowledge_event").length).toBe(1);
  });

  it("resolves relative paths against room cwd", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k6");
    writeDoc("proj/rel.md", "# Rel");
    const docsRoot = join(tmpDir, "memory", "projects");
    maybeEmitKnowledgeActivity("k6", "dev", "write", { path: "proj/rel.md" }, false, docsRoot);
    const messages = await getRoomMessages("k6");
    expect(messages.find((m) => m.type === "knowledge_event")!.knowledge_event_meta?.path).toBe("proj/rel.md");
  });

  it("marks doc writes outside the room docsPath", async () => {
    const { maybeEmitKnowledgeActivity } = await import("../../src/engine/knowledge-activity.js");
    ensureRoom("k7", { docsPath: "bossmode/" });
    const inside = writeDoc("bossmode/inside.md", "# In");
    const outside = writeDoc("other/outside.md", "# Out");
    maybeEmitKnowledgeActivity("k7", "dev", "write", { path: inside }, false, "/tmp");
    maybeEmitKnowledgeActivity("k7", "dev", "write", { path: outside }, false, "/tmp");
    const cards = (await getRoomMessages("k7")).filter((m) => m.type === "knowledge_event");
    expect(cards[0].knowledge_event_meta?.outsideRoomDocsPath).toBeUndefined();
    expect(cards[1].knowledge_event_meta?.outsideRoomDocsPath).toBe(true);
  });
});
