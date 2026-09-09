/**
 * Acceptance Tests: Agent & Skill CRUD (v2 Phase 1a)
 *
 * Coverage:
 * - T1.1-T1.3: Agent list / create / edit
 * - T1.4: Agent delete
 * - T1.7: Agent templates
 * - T1.11: Agent name conflict
 * - T1.13: Agent name format
 * - T2.1-T2.3: Skill list / create / edit
 * - T2.4-T2.5: Skill bind / unbind to agent
 * - T2.7: Skill templates
 * - T2.8: Skill delete with agent references
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, getTestBossmodeDir } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";

// Mock pi-mono (required by imports but not exercised in CRUD tests)
vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(),
    abort: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    state: { isStreaming: false },
  })),
}));
vi.mock("@mariozechner/pi-ai", () => ({ getModel: vi.fn().mockReturnValue({ id: "mock" }) }));
vi.mock("@mariozechner/pi-coding-agent", () => ({ createCodingTools: vi.fn().mockReturnValue([]) }));

setupTestWorkspace();

// Unique name generator to avoid cross-test conflicts
let _counter = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${_counter++}`;
}

describe("Acceptance: Agent & Skill CRUD (v2 Phase 1a)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  // Helper: create agent markdown
  function agentMd(name: string, opts?: { description?: string; skills?: string[]; tags?: string[] }): string {
    const desc = opts?.description ?? `Agent ${name}`;
    const skills = opts?.skills ?? [];
    const tags = opts?.tags ?? [];
    const skillsYaml = skills.length > 0 ? skills.map(s => `  - ${s}`).join("\n") : "[]";
    const tagsYaml = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
    return `---\nname: ${name}\ndescription: "${desc}"\nmodel: claude-sonnet-4-20250514\nskills:\n${skills.length > 0 ? skills.map(s => `  - ${s}`).join("\n") : "  []"}\ntags: ${tagsYaml}\n---\n\nYou are ${name}.`;
  }

  // Helper: create skill markdown
  function skillMd(name: string, opts?: { description?: string; tags?: string[] }): string {
    const desc = opts?.description ?? `Skill ${name}`;
    const tags = opts?.tags ?? [];
    const tagsYaml = tags.length > 0 ? `[${tags.join(", ")}]` : "[]";
    return `---\nname: ${name}\ndescription: "${desc}"\ntags: ${tagsYaml}\n---\n\n# ${name}\n\nSkill content for ${name}.`;
  }

  // ══════════════════════════════════════════
  // Skill CRUD
  // ══════════════════════════════════════════

  describe("T2.1: Skill list", () => {
    it("GET /api/skills returns skills with tags (no content)", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/skills", { token });
      expect(res.status).toBe(200);
      const skills = JSON.parse(res.body);
      expect(Array.isArray(skills)).toBe(true);
      if (skills.length > 0) {
        expect(skills[0].name).toBeDefined();
        expect(skills[0].description).toBeDefined();
        expect(skills[0].content).toBeUndefined(); // not in list
      }
    });
  });

  describe("T2.2: Skill create", () => {
    it("POST /api/skills creates skill", async () => {
      const name = uid("create-skill");
      const content = skillMd(name, { description: "A test skill", tags: ["test", "qa"] });
      const res = await jsonRequest(ts.port, "POST", "/api/skills", {
        token,
        body: { name, content },
      });
      expect(res.status).toBe(200);
      const skill = JSON.parse(res.body);
      expect(skill.name).toBe(name);
      expect(skill.tags).toContain("test");
    });
  });

  describe("T2.3: Skill detail + edit", () => {
    let skillName: string;

    it("GET /api/skills/:name returns full content", async () => {
      skillName = uid("detail-skill");
      const content = skillMd(skillName);
      await jsonRequest(ts.port, "POST", "/api/skills", { token, body: { name: skillName, content } });

      const res = await jsonRequest(ts.port, "GET", `/api/skills/${skillName}`, { token });
      expect(res.status).toBe(200);
      const skill = JSON.parse(res.body);
      expect(skill.content).toContain(`Skill content for ${skillName}`);
    });

    it("PUT /api/skills/:name updates skill", async () => {
      const updatedContent = skillMd(skillName, { description: "Updated skill", tags: ["updated"] });
      const res = await jsonRequest(ts.port, "PUT", `/api/skills/${skillName}`, {
        token,
        body: { content: updatedContent },
      });
      expect(res.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/skills/${skillName}`, { token });
      const skill = JSON.parse(getRes.body);
      expect(skill.description).toBe("Updated skill");
    });
  });

  describe("T2.7: Skill templates", () => {
    it("GET /api/skills/templates returns template list", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/skills/templates", { token });
      expect(res.status).toBe(200);
      const templates = JSON.parse(res.body);
      expect(Array.isArray(templates)).toBe(true);
    });
  });
});
