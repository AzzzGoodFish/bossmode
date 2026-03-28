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
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
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

setupConfigMock();

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
  // Agent CRUD
  // ══════════════════════════════════════════

  describe("T1.1: Agent list", () => {
    it("GET /api/agents returns agents with skills/tags", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/agents", { token });
      expect(res.status).toBe(200);
      const agents = JSON.parse(res.body);
      expect(Array.isArray(agents)).toBe(true);
      // Each agent should have name, description, model, skills, tags (no systemPrompt in list)
      if (agents.length > 0) {
        const a = agents[0];
        expect(a.name).toBeDefined();
        expect(a.description).toBeDefined();
        expect(Array.isArray(a.skills)).toBe(true);
        expect(Array.isArray(a.tags)).toBe(true);
        expect(a.systemPrompt).toBeUndefined(); // not in list
      }
    });
  });

  describe("T1.2: Agent create", () => {
    it("POST /api/agents creates agent from markdown", async () => {
      const name = uid("create-agent");
      const content = agentMd(name, { description: "A test agent", tags: ["test"] });
      const res = await jsonRequest(ts.port, "POST", "/api/agents", {
        token,
        body: { name, content },
      });
      expect(res.status).toBe(200);
      const agent = JSON.parse(res.body);
      expect(agent.name).toBe(name);
      expect(agent.description).toBe("A test agent");
      expect(agent.tags).toContain("test");
    });
  });

  describe("T1.3: Agent detail + edit", () => {
    let detailName: string;

    it("GET /api/agents/:name returns full definition with systemPrompt", async () => {
      detailName = uid("detail-agent");
      const content = agentMd(detailName, { description: "Detail test" });
      await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name: detailName, content } });

      const res = await jsonRequest(ts.port, "GET", `/api/agents/${detailName}`, { token });
      expect(res.status).toBe(200);
      const agent = JSON.parse(res.body);
      expect(agent.name).toBe(detailName);
      expect(agent.systemPrompt).toContain(`You are ${detailName}`);
    });

    it("PUT /api/agents/:name updates agent", async () => {
      const updatedContent = agentMd(detailName, { description: "Updated description", tags: ["updated"] });
      const res = await jsonRequest(ts.port, "PUT", `/api/agents/${detailName}`, {
        token,
        body: { content: updatedContent },
      });
      expect(res.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/agents/${detailName}`, { token });
      const agent = JSON.parse(getRes.body);
      expect(agent.description).toBe("Updated description");
      expect(agent.tags).toContain("updated");
    });
  });

  describe("T1.4: Agent delete", () => {
    it("DELETE /api/agents/:name removes agent", async () => {
      const name = uid("delete-agent");
      const content = agentMd(name);
      await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name, content } });

      const delRes = await jsonRequest(ts.port, "DELETE", `/api/agents/${name}`, { token });
      expect(delRes.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/agents/${name}`, { token });
      expect(getRes.status).toBe(404);
    });
  });

  describe("T1.11: Agent name conflict", () => {
    it("POST /api/agents with duplicate name returns 409", async () => {
      const name = uid("dupe-agent");
      const content = agentMd(name);
      await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name, content } });

      const res = await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name, content } });
      expect(res.status).toBe(409);
    });
  });

  describe("T1.7: Agent templates", () => {
    it("GET /api/agents/templates returns template list", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/agents/templates", { token });
      expect(res.status).toBe(200);
      const templates = JSON.parse(res.body);
      expect(Array.isArray(templates)).toBe(true);
      // Should have prebuilt templates (PM, Architect, Developer, QA, Designer)
    });
  });

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

  describe("T2.4: Skill bind to agent", () => {
    it("creating agent with skills list binds skills", async () => {
      const sName = uid("bind-skill");
      await jsonRequest(ts.port, "POST", "/api/skills", { token, body: { name: sName, content: skillMd(sName) } });

      const aName = uid("skilled-agent");
      const content = agentMd(aName, { skills: [sName] });
      const res = await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name: aName, content } });
      expect(res.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/agents/${aName}`, { token });
      const agent = JSON.parse(getRes.body);
      expect(agent.skills).toContain(sName);
    });
  });

  describe("T2.5: Skill unbind", () => {
    it("updating agent with empty skills removes binding", async () => {
      const sName = uid("unbind-skill");
      await jsonRequest(ts.port, "POST", "/api/skills", { token, body: { name: sName, content: skillMd(sName) } });

      const aName = uid("unbind-agent");
      await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name: aName, content: agentMd(aName, { skills: [sName] }) } });

      // Unbind by updating with empty skills
      const updatedContent = agentMd(aName, { skills: [] });
      const res = await jsonRequest(ts.port, "PUT", `/api/agents/${aName}`, { token, body: { content: updatedContent } });
      expect(res.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/agents/${aName}`, { token });
      const agent = JSON.parse(getRes.body);
      expect(agent.skills).toEqual([]);
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

  describe("T2.8: Skill delete with agent references", () => {
    it("DELETE /api/skills/:name removes skill and unbinds from agents", async () => {
      const sName = uid("del-skill");
      await jsonRequest(ts.port, "POST", "/api/skills", { token, body: { name: sName, content: skillMd(sName) } });

      const aName = uid("ref-agent");
      await jsonRequest(ts.port, "POST", "/api/agents", { token, body: { name: aName, content: agentMd(aName, { skills: [sName] }) } });

      // Delete the skill
      const delRes = await jsonRequest(ts.port, "DELETE", `/api/skills/${sName}`, { token });
      expect(delRes.status).toBe(200);

      // Verify skill gone
      const skillRes = await jsonRequest(ts.port, "GET", `/api/skills/${sName}`, { token });
      expect(skillRes.status).toBe(404);

      // Verify agent's skills list no longer references it
      const agentRes = await jsonRequest(ts.port, "GET", `/api/agents/${aName}`, { token });
      const agent = JSON.parse(agentRes.body);
      expect(agent.skills).not.toContain(sName);
    });
  });

  // ══════════════════════════════════════════
  // Edge cases
  // ══════════════════════════════════════════

  describe("Edge: nonexistent resources", () => {
    it("GET /api/agents/nonexistent returns 404", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/agents/no-such-agent", { token });
      expect(res.status).toBe(404);
    });

    it("GET /api/skills/nonexistent returns 404", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/skills/no-such-skill", { token });
      expect(res.status).toBe(404);
    });

    it("DELETE /api/agents/nonexistent returns 404", async () => {
      const res = await jsonRequest(ts.port, "DELETE", "/api/agents/no-such-agent", { token });
      expect(res.status).toBe(404);
    });
  });
});
