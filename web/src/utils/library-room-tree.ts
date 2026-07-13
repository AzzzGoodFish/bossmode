import type { KnowledgeTreeNode, Room } from "../api/client";

export interface LibraryTreeGroup {
  id: string;
  label: string;
  rootPath: string;
  nodes: KnowledgeTreeNode[];
  isGlobal?: boolean;
}

export function normalizeRoomDocsPath(path?: string | null): string {
  return (path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^docs\//, "")
    .replace(/\/+$/, "");
}

function isWithinPath(path: string, rootPath: string): boolean {
  if (!rootPath) return true;
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

function cloneNode(node: KnowledgeTreeNode): KnowledgeTreeNode {
  return {
    ...node,
    children: node.children?.map(cloneNode),
  };
}

function findNode(nodes: KnowledgeTreeNode[], targetPath: string): KnowledgeTreeNode | null {
  if (!targetPath) return { path: "", name: "", kind: "folder", children: nodes };
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.kind === "folder" && node.children) {
      const found = findNode(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function cloneDocsPathNodes(nodes: KnowledgeTreeNode[], docsPath: string): KnowledgeTreeNode[] {
  if (!docsPath) return [];
  const node = findNode(nodes, docsPath);
  if (!node) return [];
  if (node.kind === "folder") return (node.children || []).map(cloneNode);
  return [cloneNode(node)];
}

function removeAssigned(nodes: KnowledgeTreeNode[], assignedRoots: string[]): KnowledgeTreeNode[] {
  const result: KnowledgeTreeNode[] = [];
  for (const node of nodes) {
    if (assignedRoots.some((root) => isWithinPath(node.path, root))) continue;
    if (node.kind === "folder") {
      const children = removeAssigned(node.children || [], assignedRoots);
      if (children.length > 0) result.push({ ...node, children });
      continue;
    }
    result.push(cloneNode(node));
  }
  return result;
}

export function buildLibraryTreeGroups(rooms: Room[], tree: KnowledgeTreeNode | null): LibraryTreeGroup[] {
  const rootNodes = tree?.children || [];
  const roomGroups = rooms.map((room) => {
    const rootPath = normalizeRoomDocsPath(room.docsPath);
    return {
      id: room.id,
      label: room.name,
      rootPath,
      nodes: cloneDocsPathNodes(rootNodes, rootPath),
    };
  });

  const assignedRoots = roomGroups.map((group) => group.rootPath).filter(Boolean);
  return [
    ...roomGroups,
    {
      id: "__global_unfiled__",
      label: "Global / Unfiled",
      rootPath: "",
      nodes: removeAssigned(rootNodes, assignedRoots),
      isGlobal: true,
    },
  ];
}

export function visibleLibraryTreePaths(groups: LibraryTreeGroup[], expanded: Set<string>): string[] {
  const out: string[] = [];
  const walk = (nodes: KnowledgeTreeNode[]) => {
    for (const node of nodes) {
      out.push(node.path);
      if (node.kind === "folder" && expanded.has(node.path) && node.children) walk(node.children);
    }
  };
  for (const group of groups) walk(group.nodes);
  return out;
}
