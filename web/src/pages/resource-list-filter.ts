export interface SearchableWorkspaceResource {
  name?: string | null;
  description?: string | null;
  tags?: Array<string | null | undefined> | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function matchesWorkspaceResourceSearch(resource: SearchableWorkspaceResource, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    text(resource.name).toLowerCase().includes(needle) ||
    text(resource.description).toLowerCase().includes(needle) ||
    (resource.tags ?? []).some((tag) => text(tag).toLowerCase().includes(needle))
  );
}
