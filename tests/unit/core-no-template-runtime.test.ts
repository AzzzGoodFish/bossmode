import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeTestServer, createMockRoom, createTestServer,
  getTestWorkspace, jsonRequest, loginAndGetToken, setupTestWorkspace,
} from "../helpers/test-server.js";
import { mockPromptFn, resetMocks } from "../helpers/mock-runtime.js";
import { postMessage } from "../../src/chat/message-bus.js";
import { activateDmMember, activateAgent, getAgentInstanceForScope, resolveSkills } from "../../src/app/member-actions.js";
import { buildMemberAgentSession, getRegistry, reloadMemberSession } from "../../src/agent/assembly.js";
import { notifyMemberProfileChanged } from "../../src/agent/instance.js";
import { getMember, updateMember } from "../../src/member/identity.js";
import { memberProfilePath } from "../../src/files/layout.js";
import { getRuntimeStateEntry } from "../../src/agent/instance.js";
import { getCurrentSession } from "../../src/member/sessions.js";
import { storeRoom, readStoredRoom } from "../../src/chat/conversations.js";
import { readTemplateMetadata, deleteTemplateMetadata, importTemplateMetadata } from "../../src/member/templates.js";
import { resolveRoomMember, resolveRoomMembers } from "../../src/app/member-actions.js";
import type { AgentMemberConfig } from "../../src/kernel/types.js";

import { importHistoricalAgentTemplate } from "../helpers/historical-agent-template.js";
setupTestWorkspace();
beforeEach(() => importHistoricalAgentTemplate(getTestWorkspace(), "general", "---\nname: general\n---\nHistorical template body\n"));

// Damage the explicitly imported historical fixture, restoring it after each case.
function damageHistoricalTemplate(mode: string): () => void {
  const fixture = getTestWorkspace();
  const templates = fixture.db;
  const original = readTemplateMetadata("general", templates)!;
  const path = join(fixture.root, original.personaPath);
  const body = readFileSync(path);
  if (mode === "absent catalog") deleteTemplateMetadata("general", templates);
  if (mode === "corrupt catalog path") {
    fixture.db.run("UPDATE agent_templates SET persona_path=? WHERE slug=?", "invalid-persona-reference", "general");
  }
  if (mode === "missing body" || mode === "absent catalog") rmSync(path);
  if (mode === "unreadable body") {
    rmSync(path);
    mkdirSync(path);
  }
  return () => {
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, body);
    importTemplateMetadata(original, templates);
  };
}

describe("current runtime does not depend on historical agent templates", () => {
  it.each(["absent catalog", "missing body", "corrupt catalog path", "unreadable body"])(
    "%s cannot change room/DM creation, preview, identity refresh or reload",
    async mode => {
      const server = await createTestServer();
      resetMocks();
      let restore = () => {};
      try {
        const token = await loginAndGetToken(server.port);
        const room = await createMockRoom(server.port, token, mode, [`runtime-${mode}`]);
        const id = room.globalMemberIds![0];
        const raw = "---\nname: not the identity\n---\n\n  Literal persona.\n";
        writeFileSync(memberProfilePath(id), raw);
        updateMember(id, { global: { ...getMember(id)!.global, skills: [] } });
        restore = damageHistoricalTemplate(mode);

        const scopes = [`room:${room.id}`, `dm:${id}`];
        let liveInstance: Awaited<ReturnType<typeof buildMemberAgentSession>> | null = null;
        const runtime = getRegistry()!.get("pi-cli")!;
        const create = vi.spyOn(runtime, "createAgent");
        const publicResponse = await jsonRequest(server.port, "GET", `/api/members/${id}`, { token });
        expect(publicResponse.status, publicResponse.body).toBe(200);
        expect(JSON.parse(publicResponse.body).member).not.toHaveProperty("templateWarning");

        for (const scope of scopes) {
          const instance = await buildMemberAgentSession(id, scope);
          expect(instance).not.toBeNull();
          // ① B1: one instance per member — every chat reuses the same runtime.
          if (liveInstance) expect(instance).toBe(liveInstance);
          liveInstance = instance;
          const built = create.mock.calls.at(-1)![0];
          expect(built.member.id).toBe(id);
          expect(built.agentPrompt).toBe(`# Persona\n\nI am ${getMember(id)!.name}, an AI teammate in Bossmode.\n\n${raw.trim()}`);
          expect(built.skillNames).toEqual([]);
          expect(built.skillPaths).toEqual([]);

          const preview = await jsonRequest(server.port, "GET", `/api/members/${id}/system-prompt?scope=${encodeURIComponent(scope)}`, { token });
          expect(preview.status, preview.body).toBe(200);
          const previewText = JSON.parse(preview.body).text;
          if (scope === scopes[0]) {
            expect(previewText.startsWith([built.agentPrompt, ...built.appendSystemPrompt!].join("\n\n"))).toBe(true);
          } else {
            // The reuse path does not re-run createAgent: the member-owned
            // persona still renders for this chat.
            expect(previewText).toContain(`I am ${getMember(id)!.name}, an AI teammate in Bossmode.`);
          }

          // Preserve real session metadata publication and reload teardown.
          const file = join(built.sessionDir!, "fixture-session.jsonl");
          mkdirSync(built.sessionDir!, { recursive: true });
          writeFileSync(file, "retained SDK history\n");
          built.onSessionChanged?.({ sessionId: "fixture-session", sessionFile: file });
          expect(getCurrentSession(id)?.sessionFile).toBe(file);
          const teardown = vi.spyOn(instance!.handle, "destroyAndWait");
          expect(await reloadMemberSession(scope, id, "template-independent reload")).toEqual({ queued: false, rebuilt: true });
          expect(teardown).toHaveBeenCalledOnce();
          expect(create.mock.calls.at(-1)![0].resumeSession).toEqual({ sessionId: "fixture-session", sessionFile: file });
          expect(create.mock.calls.at(-1)![0].agentPrompt).toBe(built.agentPrompt);
          // The reload replaced the live instance — refresh the reuse anchor.
          liveInstance = await buildMemberAgentSession(id, scope);
        }

        // A cleared persona is literal empty content, never a template default.
        writeFileSync(memberProfilePath(id), "");
        const renamed = updateMember(id, { name: `当前 ${mode} \`mem_looking\`` });
        notifyMemberProfileChanged(renamed);
        const creationsBeforeRefresh = create.mock.calls.length;
        for (const [index, scope] of scopes.entries()) {
          const instance = getAgentInstanceForScope(scope, id)!;
          const refresh = vi.fn();
          instance.handle.refreshPrompt = refresh;
          expect(instance.sessionSources.compiled.agentPrompt).toBe(`# Persona\n\nI am ${renamed.name}, an AI teammate in Bossmode.`);
          const creationsBefore = create.mock.calls.length;
          if (scope.startsWith("dm:")) await activateDmMember(id);
          else {
            postMessage(room.id, "user", "Refresh identity.", []);
            await activateAgent(room.id, id);
          }
          if (index === 0) {
            // ① B1: identity refresh is member-level — the first chat's batch
            // refreshes the single instance and clears the member's dirty flag,
            // so the second chat reuses the already-refreshed identity.
            await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
            expect(refresh.mock.calls[0][0].agentPrompt).toBe(`# Persona\n\nI am ${renamed.name}, an AI teammate in Bossmode.`);
          } else {
            expect(refresh).not.toHaveBeenCalled();
          }
          await vi.waitFor(() => expect(getTestWorkspace().db.get<{ n: number }>(
            "SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='settled' AND outcome='completed'", scope.startsWith("room:") ? room.id : scope,
          )?.n).toBe(1));
          expect(create.mock.calls.length).toBe(creationsBefore);
          const preview = await jsonRequest(server.port, "GET", `/api/members/${id}/system-prompt?scope=${encodeURIComponent(scope)}`, { token });
          expect(preview.status, preview.body).toBe(200);
          expect(JSON.parse(preview.body).text).not.toContain("Literal persona.");
          expect(JSON.parse(preview.body).text).toContain(`I am ${renamed.name}, an AI teammate in Bossmode.`);
        }
        expect(mockPromptFn).toHaveBeenCalledTimes(2);
        expect(create).toHaveBeenCalledTimes(creationsBeforeRefresh);
        for (const scope of scopes) {
          expect(await reloadMemberSession(scope, id, "empty persona reload")).toEqual({ queued: false, rebuilt: true });
          expect(create.mock.calls.at(-1)![0]).toMatchObject({
            agentPrompt: `# Persona\n\nI am ${renamed.name}, an AI teammate in Bossmode.`, skillNames: [], skillPaths: [],
          });
        }
        expect(readFileSync(memberProfilePath(id), "utf8")).toBe("");
      } finally {
        // Shut down through the actual manager before restoring fixture data.
        await closeTestServer(server);
        vi.restoreAllMocks();
        restore();
      }
    },
  );

  it("skills are only the current member's explicit selection, including absent and empty lists", () => {
    const member: AgentMemberConfig = { id: "mem_skills", name: "Skills", agent: "general", type: "agent", runtime: "pi-cli" };
    expect(resolveSkills(member)).toEqual([]);
    expect(resolveSkills({ ...member, skills: [] })).toEqual([]);
    expect(resolveSkills({ ...member, skills: ["current-skill"] })).toEqual(["current-skill"]);
  });

  it("legacy snapshots and same-named templates remain display data, not executable agents", () => {
    const rooms = getTestWorkspace().db;
    for (const migrated of [false, true]) {
      const roomId = `legacy-${migrated}`;
      storeRoom({ id: roomId, name: roomId, members: ["general"], createdAt: 1, roomMembers: [{
        id: "local-general", name: "general", sourceAgent: "general", createdAt: 1, updatedAt: 1,
        config: { skills: ["historical-skill"] }, ...(migrated ? { migratedFrom: { memberName: "general" } } : {}),
      }] }, rooms);
      expect(resolveRoomMember(roomId, "general")).toBeNull();
      expect(resolveRoomMember(roomId, "qa")).toBeNull();
      expect(resolveRoomMembers(roomId, ["general", "qa"])).toEqual([]);
      expect(readStoredRoom(roomId, rooms)!.roomMembers![0].config!.skills).toEqual(["historical-skill"]);
    }
    storeRoom({ id: "legacy-names", name: "Names", members: ["general"], createdAt: 1 }, rooms);
    expect(resolveRoomMembers("legacy-names", ["general", "qa"])).toEqual([]);
  });

  it("SQL current member config wins over template and historical room config/avatar", async () => {
    const server = await createTestServer();
    try {
      const token = await loginAndGetToken(server.port);
      const room = await createMockRoom(server.port, token, "Current identity", ["current-config"]);
      const id = room.globalMemberIds![0];
      updateMember(id, { global: { skills: [], mcpServers: [], model: null, credentialId: null } });
      const rooms = getTestWorkspace().db;
      storeRoom({ ...room, roomMembers: [{ id, name: "stale-name", sourceAgent: "general", avatar: "stale-avatar",
        config: { skills: ["stale-skill"], model: "stale-model" }, createdAt: 1, updatedAt: 1 }] }, rooms);
      const templates = getTestWorkspace().db;
      const original = readTemplateMetadata("general", templates)!;
      try {
        importTemplateMetadata({ ...original, avatar: "template-avatar", skills: ["template-skill"] }, templates);
        const resolved = resolveRoomMember(room.id, id)!;
        expect(resolved).toMatchObject({ id, name: "current-config", skills: [], mcpServers: [] });
        expect(resolved.model).toBeUndefined();
        expect(resolved.credentialId).toBeUndefined();
        expect(resolved.avatar).toBeUndefined();
        expect(resolveSkills(resolved)).toEqual([]);
      } finally { importTemplateMetadata(original, templates); }
    } finally { await closeTestServer(server); }
  });
});
