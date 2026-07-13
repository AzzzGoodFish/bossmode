import { describe, expect, it } from "vitest";
import type { KnowledgeTreeNode, Room } from "../../web/src/api/client";
import { buildLibraryTreeGroups, normalizeRoomDocsPath, visibleLibraryTreePaths } from "../../web/src/utils/library-room-tree";

const room = (id: string, name: string, docsPath?: string): Room => ({
  id,
  name,
  cwd: "/tmp",
  members: [],
  docsPath,
  createdAt: 1,
});

const tree: KnowledgeTreeNode = {
  path: "",
  name: "docs",
  kind: "folder",
  children: [
    {
      path: "bossmode",
      name: "bossmode",
      kind: "folder",
      children: [
        { path: "bossmode/plan.md", name: "plan.md", kind: "file", title: "Plan" },
        {
          path: "bossmode/design",
          name: "design",
          kind: "folder",
          children: [{ path: "bossmode/design/spec.md", name: "spec.md", kind: "file", title: "Spec" }],
        },
      ],
    },
    {
      path: "freeu",
      name: "freeu",
      kind: "folder",
      children: [{ path: "freeu/growth.md", name: "growth.md", kind: "file", title: "Growth" }],
    },
    { path: "rules/team.md", name: "team.md", kind: "file", title: "Team" },
  ],
};

describe("library room tree grouping", () => {
  it("normalizes room docsPath values relative to docs root", () => {
    expect(normalizeRoomDocsPath("/docs/bossmode/")).toBe("bossmode");
    expect(normalizeRoomDocsPath("freeu")).toBe("freeu");
    expect(normalizeRoomDocsPath(undefined)).toBe("");
  });

  it("uses room.docsPath as the room group root and places unowned docs in Global / Unfiled", () => {
    const groups = buildLibraryTreeGroups([
      room("r1", "bossmode dev", "bossmode"),
      room("r2", "freeu growth", "docs/freeu"),
    ], tree);

    expect(groups.map((g) => g.label)).toEqual(["bossmode dev", "freeu growth", "Global / Unfiled"]);
    expect(groups[0].nodes.map((n) => n.path)).toEqual(["bossmode/plan.md", "bossmode/design"]);
    expect(groups[1].nodes.map((n) => n.path)).toEqual(["freeu/growth.md"]);
    expect(groups[2].nodes.map((n) => n.path)).toEqual(["rules/team.md"]);
  });

  it("keeps visible paths in rendered group order for shift selection", () => {
    const groups = buildLibraryTreeGroups([room("r1", "bossmode dev", "bossmode")], tree);
    expect(visibleLibraryTreePaths(groups, new Set(["bossmode/design", "freeu"]))).toEqual([
      "bossmode/plan.md",
      "bossmode/design",
      "bossmode/design/spec.md",
      "freeu",
      "freeu/growth.md",
      "rules/team.md",
    ]);
  });
});
