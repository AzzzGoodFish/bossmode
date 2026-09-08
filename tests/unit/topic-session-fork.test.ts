import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => state.dir,
  ensureBossmodeDir: () => mkdirSync(state.dir, { recursive: true }),
}));

import {
  pickForkLeafId,
  extractPrefixSummary,
  forkRoomSessionPrefix,
} from "../../src/engine/topic-session-fork.js";
import { saveSession } from "../../src/workspace/session-store.js";
import { createTopic, getTopic, normalizeAnchorExcerpt } from "../../src/workspace/topic-store.js";

function userEntry(id: string, text: string, parentId: string | null = null) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

describe("pickForkLeafId / extractPrefixSummary", () => {
  it("matches user entry containing the anchor excerpt", () => {
    const entries = [
      userEntry("e1", "first hello", null),
      userEntry("e2", "Please investigate the flaky test in auth", "e1"),
      userEntry("e3", "later chatter", "e2"),
    ];
    expect(pickForkLeafId(entries, "flaky test in auth")).toBe("e2");
  });

  it("guideText never matches — that was the batch-2 bug; last-user fallback would fire", () => {
    const entries = [
      userEntry("e1", "Please investigate the flaky test in auth", null),
      userEntry("e2", "later chatter after topic was created", "e1"),
    ];
    const guide = "[Topic guide] Title: Flaky | Anchor: Please investigate the flaky test in auth";
    expect(pickForkLeafId(entries, guide)).toBe("e2"); // wrong leaf if we passed guideText
    expect(pickForkLeafId(entries, "Please investigate the flaky test in auth")).toBe("e1");
  });

  it("falls back to last user entry when excerpt misses", () => {
    const entries = [
      userEntry("e1", "aaa", null),
      userEntry("e2", "bbb", "e1"),
    ];
    expect(pickForkLeafId(entries, "zzzzzzzz")).toBe("e2");
  });

  it("extracts user/assistant snippets", () => {
    const entries = [
      userEntry("e1", "do the thing", null),
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "done" },
      },
    ];
    const s = extractPrefixSummary(entries);
    expect(s).toMatch(/User: do the thing/);
    expect(s).toMatch(/Assistant: done/);
  });
});

describe("forkRoomSessionPrefix degrade + fork", () => {
  beforeEach(() => {
    state.dir = mkdtempSync(join(tmpdir(), "bossmode-fork-"));
    mkdirSync(join(state.dir, "rooms", "roomA"), { recursive: true });
  });
  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it("fresh seedMode does not touch sessions", () => {
    const r = forkRoomSessionPrefix({
      parentRoomId: "roomA",
      topicId: "topic_x",
      memberId: "rm_dev",
      cwd: state.dir,
      seedMode: "fresh",
    });
    expect(r.mode).toBe("fresh");
    expect(r.reason).toBe("seedMode=fresh");
    expect(r.sessionFile).toBeUndefined();
  });

  it("degrades to fresh when member has no room session file", () => {
    const r = forkRoomSessionPrefix({
      parentRoomId: "roomA",
      topicId: "topic_x",
      memberId: "rm_dev",
      cwd: state.dir,
      seedMode: "fork",
    });
    expect(r.mode).toBe("fresh");
    expect(r.reason).toBe("no-room-session");
  });

  it("forks a real session file into the topic sessions dir", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const roomSessDir = join(state.dir, "members", "rm_dev", "sessions", "2026-09-08", "rooms", "roomA");
    mkdirSync(roomSessDir, { recursive: true });
    const src = SessionManager.create(state.dir, roomSessDir);
    src.appendMessage({ role: "user", content: [{ type: "text", text: "anchor: investigate flaky test" }] } as any);
    src.appendMessage({ role: "assistant", content: "looking" } as any);
    src.appendMessage({ role: "user", content: [{ type: "text", text: "after the fork point" }] } as any);
    const srcFile = src.getSessionFile();
    expect(srcFile && existsSync(srcFile)).toBe(true);

    saveSession("roomA", "rm_dev", { runtime: "pi-cli", sessionFile: srcFile, sessionId: src.getSessionId() });

    const r = forkRoomSessionPrefix({
      parentRoomId: "roomA",
      topicId: "topic_fork",
      memberId: "rm_dev",
      cwd: state.dir,
      seedMode: "fork",
      anchorExcerpt: "investigate flaky test",
    });

    expect(r.mode).toBe("fork");
    expect(r.sessionFile).toBeTruthy();
    expect(r.sessionFile).not.toBe(srcFile);
    expect(existsSync(r.sessionFile!)).toBe(true);
    expect(r.sessionFile).toContain(join("members", "rm_dev", "sessions"));
    expect(r.sessionFile).toContain(join("topics", "topic_fork"));
    expect(r.prefixSummary).toMatch(/flaky test|User:/);
    // Room source file still exists untouched (at least same path).
    expect(existsSync(srcFile!)).toBe(true);
  });

  it("createTopic stores 80-char anchorExcerpt; that excerpt hits the mid entry, not last", () => {
    const long =
      "Please investigate the flaky test in auth module before we ship the RC " +
      "and also do many other words that would be clipped at eighty characters XXXXXXXXXXX";
    const topic = createTopic({
      roomId: "roomA",
      title: "Flaky",
      anchorMessageId: "msg-anchor",
      seedMode: "fork",
      guideText: "[Topic guide] Title: Flaky | Anchor: " + long,
      anchorExcerpt: normalizeAnchorExcerpt(long),
    });
    const stored = getTopic("roomA", topic.id);
    expect(stored?.anchorExcerpt).toBeTruthy();
    expect(stored!.anchorExcerpt!.length).toBeLessThanOrEqual(80);
    expect(stored!.anchorExcerpt).toMatch(/flaky test in auth/);
    expect(stored!.anchorExcerpt).not.toMatch(/\[Topic guide\]/);

    const entries = [
      userEntry("e1", "unrelated earlier", null),
      userEntry("e2", long, "e1"),
      userEntry("e3", "room chatter AFTER the topic was opened", "e2"),
    ];
    expect(pickForkLeafId(entries, stored!.anchorExcerpt)).toBe("e2");
    expect(pickForkLeafId(entries, stored!.guideText)).toBe("e3");
  });
});
