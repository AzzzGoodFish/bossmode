import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  closeTestServer, createMockRoom, createTestServer,
  getTestWorkspace, jsonRequest, loginAndGetToken, setupTestWorkspace,
} from "../helpers/test-server.js";
import { mockPromptFn, resetMocks } from "../helpers/mock-runtime.js";
import { postMessage } from "../../src/communication/message-bus.js";
import {
  activateDmMember, activateAgent, activateTopicMember, buildMemberAgentSession,
  getAgentInstanceForScope, getRegistry, notifyMemberProfileChanged,
  reloadMemberResources, reloadMemberSession, resolveSkills,
} from "../../src/engine/agent-manager.js";
import { getMember, updateMember } from "../../src/workspace/member-registry.js";
import { memberProfilePath } from "../../src/workspace/member-profile.js";
import { createTopic } from "../../src/workspace/topic-store.js";
import { getRuntimeStateEntry } from "../../src/workspace/runtime-state.js";
import { getSessions } from "../../src/workspace/session-store.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { TemplateRepository } from "../../src/storage/repositories/templates.js";
import { resolveRoomMember, resolveRoomMembers } from "../../src/workforce/room-member-resolver.js";
import type { AgentMemberConfig } from "../../src/shared/types.js";

setupTestWorkspace();

// The unchanged HTTP fixture seeds templates. Damage only that isolated fixture,
// restoring it after the case; never weaken the SQL/bootstrap helpers.
function damageHistoricalTemplate(mode: string): () => void {
  const fixture = getTestWorkspace();
  const templates = new TemplateRepository(fixture.db);
  const original = templates.get("general")!;
  const path = join(fixture.root, original.personaPath);
  const body = readFileSync(path);
  if (mode === "absent catalog") templates.delete("general");
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
    templates.upsert(original);
  };
}

describe("current runtime does not depend on historical agent templates", () => {
  it.each(["absent catalog", "missing body", "corrupt catalog path", "unreadable body"])(
    "%s cannot change room/DM/topic creation, preview, identity refresh or reload",
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

        const topic = createTopic({ roomId: room.id, title: "Runtime topic", anchorMessageId: "anchor", createdBy: "user", seedMode: "fresh" });
        const scopes = [`room:${room.id}`, `dm:${id}`, `topic:${topic.id}`];
        const runtime = getRegistry()!.get("pi-cli")!;
        const create = vi.spyOn(runtime, "createAgent");
        const publicResponse = await jsonRequest(server.port, "GET", `/api/members/${id}`, { token });
        expect(publicResponse.status, publicResponse.body).toBe(200);
        expect(JSON.parse(publicResponse.body).member).not.toHaveProperty("templateWarning");

        // Even an inactive room member gets its prompt contract refreshed.
        expect(await reloadMemberResources(room.id, id)).toMatchObject({ reloaded: false });
        expect(getRuntimeStateEntry(scopes[0], id).contractFingerprint).toEqual(expect.any(String));

        for (const scope of scopes) {
          const instance = await buildMemberAgentSession(id, scope);
          expect(instance).not.toBeNull();
          const args = create.mock.calls.at(-1)![0];
          expect(args.member.id).toBe(id);
          expect(args.agentPrompt).toBe(`# Member\n\nI am ${getMember(id)!.name}.\n\n${raw.trim()}`);
          expect(args.skillNames).toEqual([]);
          expect(args.skillPaths).toEqual([]);

          const preview = await jsonRequest(server.port, "GET", `/api/members/${id}/system-prompt?scope=${encodeURIComponent(scope)}`, { token });
          expect(preview.status, preview.body).toBe(200);
          expect(JSON.parse(preview.body).text.startsWith([args.agentPrompt, ...args.appendSystemPrompt!].join("\n\n"))).toBe(true);

          // Preserve real session metadata publication and reload teardown.
          const file = join(args.sessionDir!, "fixture-session.jsonl");
          mkdirSync(args.sessionDir!, { recursive: true });
          writeFileSync(file, "retained SDK history\n");
          args.onSessionChanged?.({ sessionId: "fixture-session", sessionFile: file });
          expect(getSessions(scope, id)[id]?.sessionFile).toBe(file);
          const teardown = vi.spyOn(instance!.handle, "destroyAndWait");
          expect(await reloadMemberSession(scope, id, "template-independent reload")).toEqual({ queued: false, rebuilt: true });
          expect(teardown).toHaveBeenCalledOnce();
          expect(create.mock.calls.at(-1)![0].resumeSession).toEqual({ sessionId: "fixture-session", sessionFile: file });
          expect(create.mock.calls.at(-1)![0].agentPrompt).toBe(args.agentPrompt);
        }

        // In-place resource reload also uses only member-owned persona/config.
        const roomInstance = getAgentInstanceForScope(scopes[0], id)!;
        const resources = vi.fn().mockResolvedValue(undefined);
        roomInstance.handle.reloadResources = resources;
        expect(await reloadMemberResources(room.id, id)).toMatchObject({ reloaded: true });
        expect(resources).toHaveBeenCalledWith(expect.objectContaining({
          agentPrompt: roomInstance.sessionSources.compiled.agentPrompt, skillNames: [], skillPaths: [],
        }));

        // A cleared persona is literal empty content, never a template default.
        writeFileSync(memberProfilePath(id), "");
        const renamed = updateMember(id, { name: `当前 ${mode} \`mem_looking\`` });
        notifyMemberProfileChanged(renamed);
        const creationsBeforeRefresh = create.mock.calls.length;
        for (const scope of scopes) {
          const instance = getAgentInstanceForScope(scope, id)!;
          const refresh = vi.fn();
          instance.handle.refreshPrompt = refresh;
          expect(instance.sessionSources.compiled.agentPrompt).toBe(`# Member\n\nI am ${renamed.name}.`);
          if (scope.startsWith("dm:")) await activateDmMember(id);
          else if (scope.startsWith("topic:")) await activateTopicMember(room.id, topic.id, id);
          else {
            postMessage(room.id, "user", "Refresh identity.", []);
            await activateAgent(room.id, id);
          }
          await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
          await vi.waitFor(() => expect(getTestWorkspace().db.get<{ n: number }>(
            "SELECT COUNT(*) n FROM queued_inputs WHERE scope_id=? AND status='settled' AND outcome='completed'", scope.startsWith("room:") ? room.id : scope,
          )?.n).toBe(1));
          expect(refresh.mock.calls[0][0].agentPrompt).toBe(`# Member\n\nI am ${renamed.name}.`);
          const preview = await jsonRequest(server.port, "GET", `/api/members/${id}/system-prompt?scope=${encodeURIComponent(scope)}`, { token });
          expect(preview.status, preview.body).toBe(200);
          expect(JSON.parse(preview.body).text).not.toContain("Literal persona.");
          expect(JSON.parse(preview.body).text).toContain(`I am ${renamed.name}.`);
        }
        expect(mockPromptFn).toHaveBeenCalledTimes(3);
        expect(create).toHaveBeenCalledTimes(creationsBeforeRefresh);
        for (const scope of scopes) {
          expect(await reloadMemberSession(scope, id, "empty persona reload")).toEqual({ queued: false, rebuilt: true });
          expect(create.mock.calls.at(-1)![0]).toMatchObject({
            agentPrompt: `# Member\n\nI am ${renamed.name}.`, skillNames: [], skillPaths: [],
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
    const rooms = new ConversationsRepository(getTestWorkspace().db);
    for (const migrated of [false, true]) {
      const roomId = `legacy-${migrated}`;
      rooms.upsertRoom({ id: roomId, name: roomId, members: ["general"], createdAt: 1, roomMembers: [{
        id: "local-general", name: "general", sourceAgent: "general", createdAt: 1, updatedAt: 1,
        config: { skills: ["historical-skill"] }, ...(migrated ? { migratedFrom: { memberName: "general" } } : {}),
      }] });
      expect(resolveRoomMember(roomId, "general")).toBeNull();
      expect(resolveRoomMember(roomId, "qa")).toBeNull();
      expect(resolveRoomMembers(roomId, ["general", "qa"])).toEqual([]);
      expect(rooms.getRoom(roomId)!.roomMembers![0].config!.skills).toEqual(["historical-skill"]);
    }
    rooms.upsertRoom({ id: "legacy-names", name: "Names", members: ["general"], createdAt: 1 });
    expect(resolveRoomMembers("legacy-names", ["general", "qa"])).toEqual([]);
  });

  it("SQL current member config wins over template and historical room config/avatar", async () => {
    const server = await createTestServer();
    try {
      const token = await loginAndGetToken(server.port);
      const room = await createMockRoom(server.port, token, "Current identity", ["current-config"]);
      const id = room.globalMemberIds![0];
      updateMember(id, { global: { skills: [], mcpServers: [], model: null, credentialId: null } });
      const rooms = new ConversationsRepository(getTestWorkspace().db);
      rooms.upsertRoom({ ...room, roomMembers: [{ id, name: "stale-name", sourceAgent: "general", avatar: "stale-avatar",
        config: { skills: ["stale-skill"], model: "stale-model" }, createdAt: 1, updatedAt: 1 }] });
      const templates = new TemplateRepository(getTestWorkspace().db);
      const original = templates.get("general")!;
      try {
        templates.upsert({ ...original, avatar: "template-avatar", skills: ["template-skill"] });
        const resolved = resolveRoomMember(room.id, id)!;
        expect(resolved).toMatchObject({ id, name: "current-config", skills: [], mcpServers: [] });
        expect(resolved.model).toBeUndefined();
        expect(resolved.credentialId).toBeUndefined();
        expect(resolved.avatar).toBeUndefined();
        expect(resolveSkills(resolved)).toEqual([]);
      } finally { templates.upsert(original); }
    } finally { await closeTestServer(server); }
  });
});
