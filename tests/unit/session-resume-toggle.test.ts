import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  setupTestWorkspace, getTestWorkspace, createTestServer, closeTestServer,
  loginAndGetToken, createMockRoom,
} from "../helpers/test-server.js";
import { MockRuntime } from "../helpers/mock-runtime.js";
import { readConfig, writeConfig } from "../../src/shared/config.js";
import { activateAgent, shutdownAll } from "../../src/engine/agent-manager.js";
import { mainSessionDirectory, saveCurrentSession, getCurrentSession } from "../../src/workspace/session-store.js";
import { updateMemberIdentity } from "../../src/workspace/member-registry.js";

setupTestWorkspace();
afterEach(() => { vi.restoreAllMocks(); });

describe("agent-manager SQL session resume toggle", () => {
  it.each([true, false, undefined])("passes the saved SQL session only when sessionResume=%s permits it", async sessionResume => {
    const server = await createTestServer();
    try {
      const token = await loginAndGetToken(server.port);
      const room = await createMockRoom(server.port, token, `Resume ${sessionResume}`, [`resume-${sessionResume}`]);
      const id = room.globalMemberIds![0];
      const directory = mainSessionDirectory(id);
      mkdirSync(directory, { recursive: true });
      const manager = SessionManager.create(getTestWorkspace().root, directory);
      manager.appendMessage({ role: "user", content: "retained requirement", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "retained answer" }], api: "openai-completions", provider: "mock", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
      const sessionFile = manager.getSessionFile()!;
      const sessionId = manager.getSessionId();
      const history = readFileSync(sessionFile, "utf8");
      saveCurrentSession(id, { runtime: "pi-cli", sessionId, sessionFile });
      updateMemberIdentity(id, { name: `renamed-${sessionResume}` });
      writeConfig({ ...readConfig(), runtime: sessionResume === undefined ? {} : { sessionResume } });
      getTestWorkspace().reopen();
      const create = vi.spyOn(MockRuntime.prototype, "createAgent");
      await activateAgent(room.id, id);
      expect(create).toHaveBeenCalledTimes(1);
      const args = create.mock.calls[0][0];
      expect(args.member.id).toBe(id);
      expect(args.member.name).toBe(`renamed-${sessionResume}`);
      expect(args.resumeSession).toEqual(sessionResume === false ? undefined : { sessionId, sessionFile });
      await shutdownAll();
      expect(getCurrentSession(id)).toMatchObject({ sessionId, sessionFile });
      expect(readFileSync(sessionFile, "utf8")).toBe(history);
      expect(SessionManager.open(sessionFile).getSessionId()).toBe(sessionId);
    } finally { await closeTestServer(server); }
  });
});
