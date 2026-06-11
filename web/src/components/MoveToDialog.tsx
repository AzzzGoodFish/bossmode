import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { Sheet } from "./Sheet";
import type { KnowledgeTreeNode } from "../api/client";

interface MoveToDialogProps {
  open: boolean;
  tree: KnowledgeTreeNode | null;
  itemCount: number;
  excludePaths?: string[];
  currentPath?: string;
  onConfirm: (destination: string) => void;
  onCancel: () => void;
}

export function MoveToDialog({
  open,
  tree,
  itemCount,
  excludePaths,
  currentPath,
  onConfirm,
  onCancel,
}: MoveToDialogProps) {
  const [selected, setSelected] = useState<string>("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const excluded = useMemo(() => new Set(excludePaths || []), [excludePaths]);

  useEffect(() => {
    if (!open) return;
    setSelected("");
    const next = new Set<string>();
    for (const p of excludePaths || []) {
      const parts = p.split("/");
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        next.add(cur);
      }
    }
    setExpanded(next);
  }, [open, excludePaths]);

  if (!open) return null;

  const folders = (tree?.children || []).filter((n) => n.kind === "folder");

  return (
    <Sheet open={open} onClose={onCancel} size="md">
      <div className="flex flex-col min-h-[50vh] max-h-[70vh]">
        <div className="px-4 py-3 border-b border-line-soft">
          <h3 className="text-sm font-semibold text-ink-1">Move to...</h3>
          <p className="text-xs text-ink-3 mt-0.5">Move {itemCount} item{itemCount === 1 ? "" : "s"} to selected folder</p>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <button
            onClick={() => setSelected("")}
            className={`w-full text-left text-xs px-2 py-1.5 rounded mb-1 border ${selected === ""
              ? "bg-accent-dim border-accent/40 text-accent-ink"
              : "border-transparent text-ink-2 hover:bg-surface-2"}`}
          >
            docs/ <span className="text-ink-4">(root)</span>
          </button>

          <ul className="space-y-0.5">
            {folders.map((folder) => (
              <FolderNode
                key={folder.path}
                node={folder}
                depth={0}
                expanded={expanded}
                selected={selected}
                currentPath={currentPath}
                excluded={excluded}
                onToggle={(path) => {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    next.has(path) ? next.delete(path) : next.add(path);
                    return next;
                  });
                }}
                onSelect={setSelected}
              />
            ))}
          </ul>
        </div>

        <div className="px-4 py-3 border-t border-line-soft flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-ink-3 hover:text-ink-1 cursor-pointer"
          >
            Cancel
          </button>
          <button
            disabled={selected === "" ? false : excluded.has(selected)}
            onClick={() => onConfirm(selected)}
            className="px-3 py-1.5 text-sm rounded bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 cursor-pointer"
          >
            Move
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function FolderNode({
  node,
  depth,
  expanded,
  selected,
  currentPath,
  excluded,
  onToggle,
  onSelect,
}: {
  node: KnowledgeTreeNode;
  depth: number;
  expanded: Set<string>;
  selected: string;
  currentPath?: string;
  excluded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selected === node.path;
  const isExcluded = excluded.has(node.path);
  const isCurrent = currentPath === node.path;
  const children = (node.children || []).filter((c) => c.kind === "folder");

  return (
    <li>
      <div
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        className={`group flex items-center gap-1.5 rounded px-1.5 py-1 text-xs ${isSelected
          ? "bg-accent-dim text-accent-ink"
          : isExcluded
            ? "text-ink-4"
            : "text-ink-2 hover:bg-surface-2"}`}
      >
        <button
          onClick={() => onToggle(node.path)}
          className="shrink-0 text-ink-4 hover:text-ink-2 cursor-pointer"
        >
          {children.length > 0 ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : <span className="inline-block w-3" />}
        </button>
        <button
          disabled={isExcluded}
          onClick={() => onSelect(node.path)}
          className="flex-1 min-w-0 flex items-center gap-1.5 text-left disabled:cursor-not-allowed cursor-pointer"
        >
          <Folder size={14} className="text-think shrink-0" />
          <span className="truncate">{node.name}</span>
          {isCurrent && <span className="text-[10px] text-ink-4">current</span>}
        </button>
      </div>
      {isOpen && children.length > 0 && (
        <ul className="space-y-0.5">
          {children.map((child) => (
            <FolderNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selected={selected}
              currentPath={currentPath}
              excluded={excluded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
