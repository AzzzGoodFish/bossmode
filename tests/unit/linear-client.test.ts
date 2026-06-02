import { describe, expect, it, vi, afterEach } from "vitest";
import { LinearClient, linearPriority, resolveLinearStateId } from "../../src/integrations/linear-client.js";

afterEach(() => vi.restoreAllMocks());

describe("LinearClient", () => {
  it("sends GraphQL requests with Authorization and parses viewer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { viewer: { id: "u1", name: "Tester" } } }),
    } as any);

    const viewer = await new LinearClient("lin_api_secret", "http://linear.test/graphql").viewer();

    expect(viewer).toEqual({ id: "u1", name: "Tester" });
    expect(fetchMock).toHaveBeenCalledWith("http://linear.test/graphql", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "lin_api_secret", "Content-Type": "application/json" }),
    }));
  });

  it("lists teams without nested projects/states to stay under Linear complexity limits", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { teams: { nodes: [{ id: "team-1", name: "GoodFish", key: "GF" }] } } }),
    } as any);

    const teams = await new LinearClient("lin_api_secret", "http://linear.test/graphql").listTeams();

    expect(teams).toEqual([{ id: "team-1", name: "GoodFish", key: "GF" }]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.query).toContain("teams(first: 100)");
    expect(body.query).not.toContain("projects(first: 100)");
    expect(body.query).not.toContain("states");
  });

  it("queries projects and states separately by team", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch" as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { team: { projects: { nodes: [{ id: "p1", name: "Bossmode", url: "u" }] } } } }) } as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { team: { states: { nodes: [{ id: "s1", name: "Done", type: "completed" }] } } } }) } as any);
    const client = new LinearClient("lin_api_secret", "http://linear.test/graphql");

    expect(await client.listProjects("team-1")).toEqual([{ id: "p1", name: "Bossmode", url: "u" }]);
    expect(await client.listStates("team-1")).toEqual([{ id: "s1", name: "Done", type: "completed" }]);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as any).body).variables).toEqual({ id: "team-1" });
  });

  it("sanitizes GraphQL errors", async () => {
    vi.spyOn(globalThis, "fetch" as any).mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: "bad lin_api_secret_token" }] }),
    } as any);

    await expect(new LinearClient("lin_api_secret_token", "http://linear.test/graphql").viewer()).rejects.toThrow("[redacted]");
  });

  it("maps priority and status to Linear values", () => {
    expect(linearPriority("P0")).toBe(1);
    expect(linearPriority("P1")).toBe(2);
    expect(linearPriority("P2")).toBe(3);
    const states = [
      { id: "backlog", name: "Backlog", type: "backlog" },
      { id: "started", name: "Started", type: "started" },
      { id: "review", name: "In Review", type: "started" },
      { id: "done", name: "Done", type: "completed" },
    ];
    expect(resolveLinearStateId("todo", states)).toBe("backlog");
    expect(resolveLinearStateId("in-progress", states)).toBe("started");
    expect(resolveLinearStateId("review", states)).toBe("review");
    expect(resolveLinearStateId("done", states)).toBe("done");
  });
});
