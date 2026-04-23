import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Plus, Trash2, Pencil, FolderPlus, File as FileIcon,
  Folder, FolderOpen, ChevronRight, ChevronDown,
} from "lucide-react";
import type { KnowledgeEntry, KnowledgeTreeNode } from "../api/client";
import {
  getKnowledgeTree, getKnowledgeEntry,
  addKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry as apiDeleteEntry,
} from "../api/client";
import { Markdown } from "../components/Markdown";
import { useDialog } from "../components/dialogs";

const inputCls = "w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600";

const WIDTH_STORAGE_KEY = "bossmode.knowledge.sidebarWidth";
const EXPANDED_STORAGE_KEY = "bossmode.knowledge.expandedFolders";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 160;
const MAX_WIDTH_RATIO = 0.5;

interface KnowledgePageProps {
  initialPath?: string;
}

export function KnowledgePage({ initialPath }: KnowledgePageProps = {}) {
  const { toast, confirm, prompt } = useDialog();
  const [tree, setTree] = useState<KnowledgeTreeNode | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [currentDoc, setCurrentDoc] = useState<KnowledgeEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");

  // Resizable sidebar width (px). Persisted in localStorage.
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const raw = localStorage.getItem(WIDTH_STORAGE_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= MIN_WIDTH ? n : DEFAULT_WIDTH;
  });

  // Expanded folders (set of folder paths). Persisted in localStorage.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch { return new Set(); }
  });

  useEffect(() => {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...expanded]));
  }, [expanded]);

  const refreshTree = useCallback(() => {
    getKnowledgeTree().then(setTree).catch(console.error);
  }, []);

  useEffect(() => { refreshTree(); }, [refreshTree]);

  useEffect(() => {
    if (!initialPath || initialPath === "__new__") return;
    const topLevel = initialPath.split("/")[0];
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(topLevel);
      return next;
    });
    if (initialPath.endsWith(".md")) {
      setSelectedPath(initialPath);
    } else {
      setSelectedPath(null);
    }
  }, [initialPath]);

  const lastCreateTriggerRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialPath !== "__new__") return;
    if (lastCreateTriggerRef.current === initialPath) return;
    lastCreateTriggerRef.current = initialPath;
    handleCreateDoc("");
  }, [initialPath]);

  useEffect(() => {
    if (!selectedPath) { setCurrentDoc(null); return; }
    getKnowledgeEntry(selectedPath).then((doc) => {
      setCurrentDoc(doc);
      setDraftTitle(doc.title);
      setDraftContent(doc.content);
      setEditing(false);
    }).catch((err) => {
      toast(String(err?.message || err), "error");
      setCurrentDoc(null);
    });
  }, [selectedPath, toast]);

  const folderNode = useMemo(() => {
    if (!tree || !initialPath || initialPath === "__new__") return null;
    if (initialPath.endsWith(".md")) return null;
    if (selectedPath) return null;
    return findNodeByPath(tree, initialPath);
  }, [tree, initialPath, selectedPath]);

  useEffect(() => {
    if (!initialPath || initialPath === "__new__" || initialPath.endsWith(".md")) return;
    const topLevel = initialPath.split("/")[0];
    const el = document.querySelector(`[data-folder-path="${topLevel}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.add("folder-pulse");
    const timer = setTimeout(() => el.classList.remove("folder-pulse"), 1000);
    return () => clearTimeout(timer);
  }, [initialPath, tree]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const handleCreateDoc = async (parentPath: string) => {
    const title = await prompt("New document title", "");
    if (!title) return;
    const filename = title.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\-.\u4e00-\u9fff]/gu, "") + ".md";
    const path = parentPath ? `${parentPath}/${filename}` : filename;
    try {
      await addKnowledgeEntry(title, "", path);
      refreshTree();
      // Auto-expand parent
      if (parentPath) setExpanded((prev) => new Set(prev).add(parentPath));
      setSelectedPath(path);
    } catch (err: any) { toast(err.message, "error"); }
  };

  const handleCreateFolder = async (parentPath: string) => {
    // Folders are materialized by creating a placeholder doc inside them.
    const name = await prompt("New folder name", "");
    if (!name) return;
    const safeName = name.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\-\u4e00-\u9fff]/gu, "");
    const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
    const path = `${folderPath}/README.md`;
    try {
      await addKnowledgeEntry(name, `# ${name}\n\nFolder overview.`, path);
      refreshTree();
      setExpanded((prev) => {
        const next = new Set(prev);
        next.add(folderPath);
        if (parentPath) next.add(parentPath);
        return next;
      });
    } catch (err: any) { toast(err.message, "error"); }
  };

  const handleDeleteDoc = async () => {
    if (!currentDoc) return;
    if (!(await confirm(`Delete "${currentDoc.title}"?`))) return;
    try {
      await apiDeleteEntry(currentDoc.id);
      refreshTree();
      setSelectedPath(null);
    } catch (err: any) { toast(err.message, "error"); }
  };

  const handleSaveEdit = async () => {
    if (!currentDoc || !draftTitle) return;
    try {
      const updated = await updateKnowledgeEntry(currentDoc.id, draftTitle, draftContent);
      setCurrentDoc(updated);
      setEditing(false);
      refreshTree();
    } catch (err: any) { toast(err.message, "error"); }
  };

  // Drag-to-resize handler
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onDragMove);
    window.addEventListener("mouseup", onDragEnd);
  };
  const onDragMove = (e: MouseEvent) => {
    if (!dragRef.current) return;
    const delta = e.clientX - dragRef.current.startX;
    const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
    const next = Math.max(MIN_WIDTH, Math.min(maxWidth, dragRef.current.startWidth + delta));
    setSidebarWidth(next);
  };
  const onDragEnd = () => {
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragEnd);
    // Persist
    setSidebarWidth((w) => {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(w));
      return w;
    });
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-5 pb-3 shrink-0 border-b border-zinc-200 dark:border-zinc-800">
        <div>
          <h1 className="text-lg font-bold text-zinc-900 dark:text-white">Knowledge</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Markdown documents organized by folders. Use top-level folders to separate projects.
          </p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* File tree pane */}
        <aside
          style={{ width: `${sidebarWidth}px` }}
          className="shrink-0 border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto bg-zinc-50/50 dark:bg-zinc-900/50 flex flex-col"
        >
          <div className="px-3 pt-3 pb-2 flex items-center justify-between sticky top-0 bg-zinc-50/90 dark:bg-zinc-900/90 backdrop-blur-sm z-10">
            <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Documents</span>
            <div className="flex items-center gap-1">
              <button title="New folder at root" onClick={() => handleCreateFolder("")}
                className="p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer">
                <FolderPlus size={14} />
              </button>
              <button title="New document at root" onClick={() => handleCreateDoc("")}
                className="p-1 text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer">
                <Plus size={14} />
              </button>
            </div>
          </div>
          {tree && tree.children && tree.children.length > 0 ? (
            <TreeView
              nodes={tree.children}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggle={toggleExpanded}
              onSelect={setSelectedPath}
              onCreateDoc={handleCreateDoc}
              onCreateFolder={handleCreateFolder}
            />
          ) : (
            <div className="px-3 py-8 text-center text-xs text-zinc-400">
              Knowledge is empty.
              <br />
              Click + to add your first document.
            </div>
          )}
        </aside>

        {/* Drag handle */}
        <div
          onMouseDown={onDragStart}
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/40 transition-colors"
          title="Drag to resize"
        />

        {/* Main: document viewer/editor */}
        <main className="flex-1 overflow-y-auto">
          {currentDoc ? (
            editing ? (
              <div className="p-6">
                <input
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="Title"
                  className={`${inputCls} mb-3`}
                />
                <textarea
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="Markdown body..."
                  rows={24}
                  className={`${inputCls} font-mono text-xs resize-y`}
                />
                <div className="flex gap-2 mt-3">
                  <button onClick={handleSaveEdit}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded cursor-pointer">
                    Save
                  </button>
                  <button onClick={() => {
                    setDraftTitle(currentDoc.title);
                    setDraftContent(currentDoc.content);
                    setEditing(false);
                  }} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-6">
                <div className="flex items-center justify-between mb-3">
                  <div className="min-w-0">
                    <h2 className="text-lg font-bold text-zinc-900 dark:text-white truncate">{currentDoc.title}</h2>
                    <div className="text-xs text-zinc-500 mt-0.5 font-mono truncate">{currentDoc.id} · by {currentDoc.source}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => setEditing(true)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer">
                      <Pencil size={14} /> Edit
                    </button>
                    <button onClick={handleDeleteDoc}
                      className="flex items-center gap-1 px-3 py-1.5 text-red-500 dark:text-red-400 hover:text-red-400 dark:hover:text-red-300 text-sm cursor-pointer">
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </div>
                <div className="bg-white dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800 rounded-lg px-6 py-5 text-sm text-zinc-800 dark:text-zinc-300 leading-relaxed">
                  {currentDoc.content ? <Markdown content={currentDoc.content} /> : <em className="text-zinc-400">(empty document)</em>}
                </div>
              </div>
            )
          ) : folderNode ? (
            <FolderOverview
              node={folderNode}
              onSelectDoc={(path) => setSelectedPath(path)}
              onCreateDoc={() => handleCreateDoc(folderNode.path)}
              onCreateFolder={() => handleCreateFolder(folderNode.path)}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-zinc-400">
              Select a document from the tree to view it.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// -- File tree view --

function TreeView({ nodes, selectedPath, expanded, onToggle, onSelect, onCreateDoc, onCreateFolder }: {
  nodes: KnowledgeTreeNode[];
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onCreateDoc: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
}) {
  return (
    <ul className="text-sm pb-4">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
          onCreateDoc={onCreateDoc}
          onCreateFolder={onCreateFolder}
        />
      ))}
    </ul>
  );
}

function TreeNode({ node, depth, selectedPath, expanded, onToggle, onSelect, onCreateDoc, onCreateFolder }: {
  node: KnowledgeTreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onCreateDoc: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
}) {
  const indent = { paddingLeft: `${depth * 12 + 8}px` };
  const isSelected = selectedPath === node.path;

  if (node.kind === "folder") {
    const isOpen = expanded.has(node.path);
    return (
      <li>
        <div style={indent}
          data-folder-path={node.path}
          className="group flex items-center justify-between py-1 pr-1 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 cursor-pointer"
          onClick={() => onToggle(node.path)}
        >
          <span className="flex items-center gap-1 text-zinc-700 dark:text-zinc-300 min-w-0">
            {isOpen ? <ChevronDown size={12} className="text-zinc-400 shrink-0" /> : <ChevronRight size={12} className="text-zinc-400 shrink-0" />}
            {isOpen
              ? <FolderOpen size={13} className="text-amber-500 shrink-0" />
              : <Folder size={13} className="text-amber-500 shrink-0" />}
            <span className="font-medium text-xs truncate">{node.name}</span>
          </span>
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity shrink-0">
            <button title="New folder" onClick={(e) => { e.stopPropagation(); onCreateFolder(node.path); }}
              className="p-0.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white">
              <FolderPlus size={12} />
            </button>
            <button title="New document" onClick={(e) => { e.stopPropagation(); onCreateDoc(node.path); }}
              className="p-0.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-white">
              <Plus size={12} />
            </button>
          </span>
        </div>
        {isOpen && node.children && (
          <ul>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
                onCreateDoc={onCreateDoc}
                onCreateFolder={onCreateFolder}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <div style={indent}
        onClick={() => onSelect(node.path)}
        className={`flex items-center gap-1.5 py-1 pr-1 cursor-pointer ${
          isSelected
            ? "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-300"
            : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
        }`}
      >
        {/* Spacer to align with chevron width on folder rows */}
        <span className="w-3 shrink-0" />
        <FileIcon size={12} className="text-zinc-400 shrink-0" />
        <span className="text-xs truncate" title={node.title || node.name}>
          {node.title || node.name}
        </span>
      </div>
    </li>
  );
}

function FolderOverview({
  node,
  onSelectDoc,
  onCreateDoc,
  onCreateFolder,
}: {
  node: KnowledgeTreeNode;
  onSelectDoc: (path: string) => void;
  onCreateDoc: () => void;
  onCreateFolder: () => void;
}) {
  const children = node.children ?? [];
  const subfolders = children.filter((c) => c.kind === "folder");
  const rootDocs = children.filter((c) => c.kind === "file");
  const totalDocs = useMemo(() => countDocs(node), [node]);

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Folder size={20} className="text-zinc-500 shrink-0" />
            <h2 className="text-lg font-bold text-zinc-900 dark:text-white truncate">{node.name}</h2>
          </div>
          <div className="text-xs text-zinc-500">
            {totalDocs} document{totalDocs !== 1 ? "s" : ""}
            {subfolders.length > 0 && ` · ${subfolders.length} subfolder${subfolders.length !== 1 ? "s" : ""}`}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onCreateFolder}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer"
          >
            <FolderPlus size={14} /> New folder
          </button>
          <button
            onClick={onCreateDoc}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded cursor-pointer"
          >
            <Plus size={14} /> New document
          </button>
        </div>
      </div>

      {rootDocs.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2">Documents</div>
          <div className="space-y-1">
            {rootDocs.map((doc) => (
              <DocRow key={doc.path} node={doc} onClick={() => onSelectDoc(doc.path)} />
            ))}
          </div>
        </div>
      )}

      {subfolders.map((sub) => (
        <FolderGroup key={sub.path} node={sub} onSelectDoc={onSelectDoc} />
      ))}

      {totalDocs === 0 && subfolders.length === 0 && (
        <div className="text-center py-12 text-sm text-zinc-400">
          This folder is empty. Click "New document" to add one.
        </div>
      )}
    </div>
  );
}

function FolderGroup({ node, onSelectDoc }: { node: KnowledgeTreeNode; onSelectDoc: (path: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const docs = collectDocs(node);
  const COLLAPSED_THRESHOLD = 5;
  const shouldCollapse = docs.length > COLLAPSED_THRESHOLD;
  const visible = !shouldCollapse || expanded ? docs : docs.slice(0, 3);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">{node.name}</div>
        <span className="text-[10px] text-zinc-400 tabular-nums">{docs.length}</span>
      </div>
      <div className="space-y-1">
        {visible.map((doc) => (
          <DocRow key={doc.path} node={doc} onClick={() => onSelectDoc(doc.path)} />
        ))}
        {shouldCollapse && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 px-3 py-1.5 cursor-pointer"
          >
            Show {docs.length - 3} more…
          </button>
        )}
      </div>
    </div>
  );
}

function DocRow({ node, onClick }: { node: KnowledgeTreeNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center gap-2 px-3 py-2 rounded border border-transparent hover:border-zinc-200 dark:hover:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors cursor-pointer group"
    >
      <FileIcon size={14} className="text-zinc-400 dark:text-zinc-600 shrink-0" />
      <span className="text-sm text-zinc-800 dark:text-zinc-300 group-hover:text-zinc-900 dark:group-hover:text-white truncate">
        {node.title || node.name.replace(/\.md$/i, "")}
      </span>
    </button>
  );
}

function collectDocs(node: KnowledgeTreeNode): KnowledgeTreeNode[] {
  const out: KnowledgeTreeNode[] = [];
  for (const c of node.children ?? []) {
    if (c.kind === "file") out.push(c);
    else out.push(...collectDocs(c));
  }
  return out;
}

function countDocs(node: KnowledgeTreeNode): number {
  let n = 0;
  for (const c of node.children ?? []) {
    if (c.kind === "file") n++;
    else n += countDocs(c);
  }
  return n;
}

function findNodeByPath(root: KnowledgeTreeNode, path: string): KnowledgeTreeNode | null {
  if (root.path === path) return root;
  for (const child of root.children ?? []) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}
