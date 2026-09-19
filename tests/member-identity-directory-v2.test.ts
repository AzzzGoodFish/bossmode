import { expect, it } from "vitest";
import { closeTestServer, createTestServer, jsonRequest, loginAndGetToken, setupTestWorkspace } from "./helpers/test-server.js";
import { getDatabase } from "../src/data/database.js";
import {
  getRetainedMember,
  insertMemberIdentity,
  listMemberIdentityDirectory,
  listMembers,
  retireMemberIdentity,
  updateMember,
  type MemberRecord,
} from "../src/member/identity.js";

setupTestWorkspace();

function member(id: string, name: string, now: number): MemberRecord {
  return {
    id,
    name,
    agentTemplate: "general",
    global: { model: null, credentialId: null, thinkingLevel: null, skills: [], mcpServers: [] },
    createdAt: now,
    updatedAt: now,
  };
}

it("serves one complete retained id/name snapshot without admitting name-only archives", async () => {
  const server = await createTestServer();
  try {
    const db = getDatabase();
    const token = await loginAndGetToken(server.port);
    const archivedId = "mem_zzzzzzzzzz";
    const activeId = "mem_aaaaaaaaaa";
    const now = Date.now();

    insertMemberIdentity(member(archivedId, "old", now), db);
    updateMember(archivedId, { name: "final" });
    retireMemberIdentity(archivedId, `backups/fired-${archivedId}-fixture`, now + 1, db);
    insertMemberIdentity(member(activeId, "old", now + 2), db);

    // A legacy archive can carry a name but no verified stable member ID. It is
    // historical catalog data, never an identity-directory row.
    db.run(`INSERT INTO member_archives(
      archive_path,source_name,member_id,kind,template,title,global_json,persona_path,persona_format,has_persona
    ) VALUES(?,?,NULL,'legacy','general',NULL,'{}',NULL,'plain',0)`, "backups/legacy-name-only", "ghost");

    const expected = [
      { id: activeId, name: "old" },
      { id: archivedId, name: "final" },
    ];
    expect(listMemberIdentityDirectory(db)).toEqual(expected);
    expect(listMembers(db).map(({ id, name }) => ({ id, name }))).toEqual([{ id: activeId, name: "old" }]);
    expect(getRetainedMember(archivedId, db)?.name).toBe("final");

    const identities = await jsonRequest(server.port, "GET", "/api/members/identities", { token });
    expect(identities.status).toBe(200);
    const body = JSON.parse(identities.body) as { members: Array<Record<string, unknown>> };
    expect(body).toEqual({ members: expected });
    expect(body.members.every(row => Object.keys(row).sort().join(",") === "id,name")).toBe(true);
    expect(body.members.some(row => row.name === "ghost")).toBe(false);

    const executable = await jsonRequest(server.port, "GET", "/api/members", { token });
    expect(executable.status).toBe(200);
    expect((JSON.parse(executable.body) as { members: Array<{ id: string }> }).members.map(row => row.id)).toEqual([activeId]);
  } finally {
    await closeTestServer(server);
  }
});
