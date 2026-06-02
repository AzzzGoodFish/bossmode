import type { TaskPriority, TaskStatus } from "../shared/types.js";

export interface LinearState { id: string; name: string; type?: string }
export interface LinearProject { id: string; name: string; url?: string }
export interface LinearTeam { id: string; name: string; key?: string; states?: LinearState[]; projects?: LinearProject[] }
export interface LinearIssueRef { id: string; identifier: string; url: string }

export interface CreateLinearIssueInput { teamId: string; title: string; description?: string; priority?: number; stateId?: string; projectId?: string }
export interface UpdateLinearIssueInput { title?: string; description?: string; priority?: number; stateId?: string }

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";

function sanitizeError(message: string): string {
  return message.replace(/lin_api_[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500);
}

export class LinearClient {
  constructor(private apiKey: string, private endpoint = process.env.LINEAR_API_URL || DEFAULT_ENDPOINT) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (data.errors?.length) throw new Error(sanitizeError(data.errors.map((e: any) => e.message).join("; ")));
    if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`);
    return data.data as T;
  }

  async viewer(): Promise<{ id: string; name: string }> {
    const data = await this.gql<{ viewer: { id: string; name: string } }>(`query Viewer { viewer { id name } }`);
    return data.viewer;
  }

  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.gql<any>(`query Teams { teams(first: 100) { nodes { id name key } } }`);
    return data.teams?.nodes || [];
  }

  async listProjects(teamId: string): Promise<LinearProject[]> {
    const data = await this.gql<any>(`query TeamProjects($id: String!) { team(id: $id) { projects(first: 100) { nodes { id name url } } } }`, { id: teamId });
    return data.team?.projects?.nodes || [];
  }

  async listStates(teamId: string): Promise<LinearState[]> {
    const data = await this.gql<any>(`query TeamStates($id: String!) { team(id: $id) { states { nodes { id name type } } } }`, { id: teamId });
    return data.team?.states?.nodes || [];
  }

  async getTeamDetails(teamId: string): Promise<LinearTeam | undefined> {
    const teams = await this.listTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) return undefined;
    const [projects, states] = await Promise.all([this.listProjects(teamId), this.listStates(teamId)]);
    return { ...team, projects, states };
  }

  async createIssue(input: CreateLinearIssueInput): Promise<LinearIssueRef> {
    const data = await this.gql<any>(`mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`, { input });
    if (!data.issueCreate?.success) throw new Error("Linear issueCreate failed");
    return data.issueCreate.issue;
  }

  async updateIssue(issueId: string, input: UpdateLinearIssueInput): Promise<LinearIssueRef> {
    const data = await this.gql<any>(`mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier url } } }`, { id: issueId, input });
    if (!data.issueUpdate?.success) throw new Error("Linear issueUpdate failed");
    return data.issueUpdate.issue;
  }

  async createComment(issueId: string, body: string): Promise<void> {
    const data = await this.gql<any>(`mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`, { input: { issueId, body } });
    if (!data.commentCreate?.success) throw new Error("Linear commentCreate failed");
  }
}

export function linearPriority(priority: TaskPriority): number {
  return priority === "P0" ? 1 : priority === "P1" ? 2 : 3;
}

function byName(states: LinearState[], names: string[]): LinearState | undefined {
  const lower = names.map((n) => n.toLowerCase());
  return states.find((s) => lower.includes(s.name.toLowerCase()));
}

export function resolveLinearStateId(status: TaskStatus, states: LinearState[] = []): string | undefined {
  if (status === "todo") return states.find((s) => s.type === "backlog")?.id || byName(states, ["Backlog"])?.id || states.find((s) => s.type === "unstarted")?.id;
  if (status === "in-progress") return byName(states, ["In Progress"])?.id || states.find((s) => s.type === "started")?.id;
  if (status === "review") return byName(states, ["In Review", "Review"])?.id || states.find((s) => s.type === "started")?.id;
  return states.find((s) => s.type === "completed")?.id || byName(states, ["Done"])?.id;
}

export function findTeam(teams: LinearTeam[], query: string): LinearTeam | undefined {
  const q = query.trim().toLowerCase();
  return teams.find((t) => t.id.toLowerCase() === q || t.key?.toLowerCase() === q || t.name.toLowerCase() === q);
}

export function findProject(projects: LinearProject[], query: string): LinearProject | undefined {
  const q = query.trim().toLowerCase();
  return projects.find((p) => p.id.toLowerCase() === q || p.name.toLowerCase() === q);
}
