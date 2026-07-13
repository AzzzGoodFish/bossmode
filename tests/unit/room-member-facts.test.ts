import { beforeAll, describe, expect, it } from "vitest";

let matchesAgentFact: (fact: any, agentName: string) => boolean;
let projectRoomMemberFacts: (rooms: any[], membersByRoom: Map<string, any[]>, tokenUsageByMember?: Map<string, number>) => any[];

beforeAll(async () => {
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    configurable: true,
  });
  ({ matchesAgentFact, projectRoomMemberFacts } = await import("../../web/src/pages/room-member-facts.ts"));
});

describe("Team room-member facts", () => {
  it("projects only persisted room-local facts and keeps same-agent members separate", () => {
    const rooms = [{
      id: "room-1",
      name: "Product",
      cwd: "/workspace",
      members: ["dev-a", "dev-b"],
      createdAt: 1,
      agentStatuses: { "dev-a": "working", "dev-b": "idle" },
    }];
    const membersByRoom = new Map([["room-1", [
      { id: "rm-a", name: "dev-a", agent: "developer", thinkingLevel: "max", model: "openai/gpt-5.6-luna", mcpServers: [] },
      { id: "rm-b", name: "dev-b", agent: "developer", sourceAgent: "developer", thinkingLevel: "high", model: null, mcpServers: ["playwright"] },
    ]]]);

    const facts = projectRoomMemberFacts(rooms, membersByRoom, new Map([["room-1:rm-a", 42], ["room-1:rm-b", 99]]));

    expect(facts).toEqual([
      expect.objectContaining({ memberId: "rm-a", memberName: "dev-a", status: "working", mcpServers: [], totalTokens: 42 }),
      expect.objectContaining({ memberId: "rm-b", memberName: "dev-b", status: "idle", mcpServers: ["playwright"], totalTokens: 99 }),
    ]);
    expect(facts.filter((fact: any) => matchesAgentFact(fact, "developer")).map((fact: any) => fact.memberName)).toEqual(["dev-a", "dev-b"]);
  });

  it("does not invent model, MCP, status, or token data when fields are absent", () => {
    const facts = projectRoomMemberFacts(
      [{ id: "room-empty", name: "Empty facts", cwd: "/workspace", members: ["architect"], createdAt: 1 }],
      new Map([["room-empty", [{ id: "rm-architect", name: "architect", agent: "architect", thinkingLevel: "", mcpServers: [] }]]]),
    );

    expect(facts[0]).toMatchObject({ model: null, mcpServers: [], status: "inactive", totalTokens: 0 });
  });
});
