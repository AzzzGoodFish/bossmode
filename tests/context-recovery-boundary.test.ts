import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, SettingsManager, type ExtensionContext, type ExtensionFactory, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { ContextRecovery, isRecoveryBoundary, recoveryPrompt } from "../src/agent/runtime/context-recovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bossmode-recovery-boundary-"));
  roots.push(root);
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "ORIGINAL_WORK_RECORD", timestamp: Date.now() - 2000 });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "ALREADY_COMPLETED_ACTION" }],
    api: "openai-completions", provider: "openai", model: "fixture",
    usage: { input: 50_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 50_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now() - 1000,
  });
  const policy = new ContextRecovery(manager, () => "room:rm_fixture");
  let hook!: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => any;
  await policy.extension.factory({ on: (_name: string, callback: typeof hook) => { hook = callback; } } as Parameters<ExtensionFactory>[0]);
  const abort = vi.fn();
  const ctx = { abort } as unknown as ExtensionContext;
  const event = (reason: SessionBeforeCompactEvent["reason"], signal = new AbortController().signal) => ({
    type: "session_before_compact", reason, willRetry: reason === "overflow", signal,
    preparation: { tokensBefore: 50_100 }, branchEntries: manager.getBranch(),
  }) as SessionBeforeCompactEvent;
  return { root, manager, policy, hook, event, ctx, abort, file: manager.getSessionFile()! };
}

function commitBoundary(manager: SessionManager, result: any) {
  const c = result.compaction;
  manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
}

describe("append-only context recovery boundary", () => {
  it.each(["room:test", null])("routes recovery through the existing guide with bounded, on-demand pages (source: %s)", (sourceRef) => {
    const prompt = recoveryPrompt("/work/session.jsonl", sourceRef, "boundary");
    expect(prompt).toContain("Recover silently");
    expect(prompt).toContain(sourceRef ? `for ${JSON.stringify(sourceRef)} using chat_read or chat_search` : "for your current task using chat_read or chat_search");
    expect(prompt).toContain("read bossmode-guide at the guide path in Assets");
    expect(prompt).toContain("references/sessions.md");
    expect(prompt).toContain("scripts/session-search.mjs");
    expect(prompt).toContain('terminal in workspace "original"');
    expect(prompt).toContain("absolute member directory from Assets as --member-dir");
    expect(prompt).toContain('entries before "boundary" in the work log "/work/session.jsonl"');
    expect(prompt).toContain("list/search metadata and short summaries");
    expect(prompt).toContain("expand only task-relevant entries");
    expect(prompt).toContain("--max-bytes 8192 on every command (8 KiB per call)");
    expect(prompt).toContain("nextCursor");
    expect(prompt).toContain("--cursor with the same action and filters only when more information is necessary");
    expect(prompt).toContain("Never automatically drain pages or reconstruct oversized tool results");
    expect(prompt).toContain("Never read or print the entire session JSONL");
    expect(prompt).toContain("Stop recovering once");
  });

  it("passes tool results through without per-result, aggregate or content-block truncation", async () => {
    const f = await fixture();
    const text = "💡".repeat(500_000);
    const message = { role: "toolResult", toolCallId: "old-call", toolName: "read", timestamp: 1,
      content: [{ type: "text", text }, ...Array.from({ length: 129 }, (_, i) => ({ type: "text", text: `block-${i}` }))],
      details: { original: true }, isError: false } as const;
    const convert = vi.fn((messages: unknown[]) => messages);
    const session = { agent: { convertToLlm: convert } } as any;
    f.policy.install(session);
    const messages = Array(50).fill(message);
    const result = session.agent.convertToLlm(messages);
    expect(convert).toHaveBeenCalledWith(messages);
    expect(result).toBe(messages);
    for (const item of result) expect(item).toBe(message);
    expect(result[0].content).toHaveLength(130);
    expect(result[0].content[0].text).toBe(text);
    expect(result[0].details).toBe(message.details);
  });

  it.each(["threshold", "overflow"] as const)("replaces %s context without changing the session ID/file or old log", async (reason) => {
    const f = await fixture();
    const before = readFileSync(f.file);
    const id = f.manager.getSessionId();
    const result = await f.hook(f.event(reason), f.ctx);
    const marker = f.manager.getEntry(result.compaction.firstKeptEntryId);
    expect(marker?.type).toBe("custom");
    commitBoundary(f.manager, result);
    expect(f.manager.getSessionId()).toBe(id);
    expect(f.manager.getSessionFile()).toBe(f.file);
    expect(readFileSync(f.file).subarray(0, before.length)).toEqual(before);
    const messages = f.policy.projectContext(f.manager.buildSessionContext().messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "custom", content: recoveryPrompt(f.file, "room:rm_fixture", result.compaction.firstKeptEntryId) });
    expect(JSON.stringify(messages)).not.toContain("ORIGINAL_WORK_RECORD");
    expect(JSON.stringify(messages)).not.toContain("ALREADY_COMPLETED_ACTION");
    expect(JSON.stringify(messages)).not.toContain("compactionSummary");
    expect(f.abort).not.toHaveBeenCalled();
  });

  it("restores the same boundary after reopening the complete work log", async () => {
    const f = await fixture();
    const result = await f.hook(f.event("threshold"), f.ctx);
    commitBoundary(f.manager, result);
    const reopened = SessionManager.open(f.file, join(f.root, "sessions"), f.root);
    const resumedPolicy = new ContextRecovery(reopened, () => "room:rm_other");
    expect(reopened.getSessionId()).toBe(f.manager.getSessionId());
    expect(isRecoveryBoundary(resumedPolicy.currentBoundary())).toBe(true);
    const restored = resumedPolicy.projectContext(reopened.buildSessionContext().messages);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ role: "custom", content: recoveryPrompt(f.file, "room:rm_fixture", result.compaction.firstKeptEntryId) });
    expect(readFileSync(f.file, "utf8")).toContain("ORIGINAL_WORK_RECORD");
  });

  it("keeps a new input after the boundary, without resending old work", async () => {
    const f = await fixture();
    commitBoundary(f.manager, await f.hook(f.event("threshold"), f.ctx));
    f.manager.appendMessage({ role: "user", content: "NEW_INSTRUCTION", timestamp: Date.now() });
    const context = f.policy.projectContext(f.manager.buildSessionContext().messages);
    expect(context.map((message) => message.role)).toEqual(["custom", "user"]);
    expect(JSON.stringify(context)).toContain("NEW_INSTRUCTION");
    expect(JSON.stringify(context)).not.toContain("ORIGINAL_WORK_RECORD");
  });

  it("leaves manual compaction and historical summary messages untouched", async () => {
    const f = await fixture();
    const before = readFileSync(f.file);
    expect(await f.hook(f.event("manual"), f.ctx)).toBeUndefined();
    expect(readFileSync(f.file)).toEqual(before);
    const first = f.manager.getBranch().find((entry) => entry.type === "message")!;
    f.manager.appendCompaction("A real manual summary", first.id, 50_100);
    const original = f.manager.buildSessionContext().messages;
    expect(f.policy.projectContext(original)).toBe(original);
    expect(isRecoveryBoundary(f.policy.currentBoundary())).toBe(false);
  });

  it("cancels before changing the file when stopped", async () => {
    const f = await fixture();
    const before = readFileSync(f.file);
    const control = new AbortController(); control.abort();
    expect(await f.hook(f.event("threshold", control.signal), f.ctx)).toEqual({ cancel: true });
    expect(readFileSync(f.file)).toEqual(before);
  });

  it("fails closed when the work log is unavailable, including a failing abort callback", async () => {
    const f = await fixture();
    rmSync(f.file);
    f.abort.mockImplementation(() => { throw new Error("abort failed"); });
    expect(await f.hook(f.event("overflow"), f.ctx)).toEqual({ cancel: true });
    expect(() => f.policy.throwIfFailed()).toThrow("Context recovery failed");
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("does not return undefined and permit summary fallback after a write failure", async () => {
    const f = await fixture();
    vi.spyOn(f.manager, "appendCustomEntry").mockImplementation(() => { throw new Error("disk full"); });
    expect(await f.hook(f.event("threshold"), f.ctx)).toEqual({ cancel: true });
    expect(() => f.policy.throwIfFailed()).toThrow("disk full");
    const convert = vi.fn();
    const session = { agent: { convertToLlm: convert }, settingsManager: SettingsManager.inMemory() } as any;
    f.policy.install(session);
    expect(() => session.agent.convertToLlm([])).toThrow("disk full");
    expect(convert).not.toHaveBeenCalled();
  });

  it("does not change the SDK trigger or manual history-retention settings", async () => {
    const f = await fixture();
    const settings = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1234 } });
    f.policy.install({ agent: { convertToLlm: (messages: unknown[]) => messages }, settingsManager: settings } as any);
    expect(settings.getCompactionKeepRecentTokens()).toBe(1234);
  });

  it("requires the platform recovery policy to be the final loaded handler", async () => {
    const f = await fixture();
    const policy = { path: "<inline:bossmode-context-recovery>", handlers: new Map([["session_before_compact", [f.hook]]]) };
    expect(() => f.policy.assertInstalled({ getExtensions: () => ({ extensions: [policy] }) } as any)).not.toThrow();
    expect(() => f.policy.assertInstalled({ getExtensions: () => ({ extensions: [policy, { path: "later" }] }) } as any)).toThrow("loaded last");
  });
});
