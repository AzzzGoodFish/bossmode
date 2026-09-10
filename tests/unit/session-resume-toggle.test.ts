import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestWorkspace, getTestWorkspace, createTestServer, closeTestServer,
  loginAndGetToken, createMockRoom,
} from "../helpers/test-server.js";
import { MockRuntime } from "../helpers/mock-runtime.js";
import { readConfig, writeConfig } from "../../src/shared/config.js";
import { activateAgent, shutdownAll } from "../../src/engine/agent-manager.js";
import { mainSessionDirectory, saveSession, getSessions } from "../../src/workspace/session-store.js";
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
      const directory = mainSessionDirectory(id, `room:${room.id}`);
      mkdirSync(directory, { recursive: true });
      const sessionFile = join(directory, "saved.jsonl");
      writeFileSync(sessionFile, "retained SDK history\n");
      saveSession(room.id, id, { runtime: "pi-cli", sessionId: "sid-123", sessionFile });
      updateMemberIdentity(id, { name: `renamed-${sessionResume}` });
      writeConfig({ ...readConfig(), runtime: sessionResume === undefined ? {} : { sessionResume } });
      getTestWorkspace().reopen();
      const create = vi.spyOn(MockRuntime.prototype, "createAgent");
      await activateAgent(room.id, id);
      expect(create).toHaveBeenCalledTimes(1);
      const args = create.mock.calls[0][0];
      expect(args.member.id).toBe(id);
      expect(args.member.name).toBe(`renamed-${sessionResume}`);
      expect(args.resumeSession).toEqual(sessionResume === false ? undefined : { sessionId: "sid-123", sessionFile });
      await shutdownAll();
      expect(getSessions(room.id, id)[id]).toMatchObject({ sessionId: "sid-123", sessionFile });
      expect(readFileSync(sessionFile, "utf8")).toBe("retained SDK history\n");
    } finally { await closeTestServer(server); }
  });
});
