import { useState } from "react";
import type { KnowledgeTreeNode } from "../api/client";
import { Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown } from "lucide-react";

interface RulesTreeProps {
  nodes: KnowledgeTreeNode[];
  selected: Set<string>;
  onToggle: (path: string) => void;
}

export function RulesTree({ nodes, selected, onToggle }: RulesTreeProps) {
  return (
    <ul className="text-sm">
      {nodes.map((node) => (
        <RulesTreeNode key={node.path} node={node} depth={0} selected={selected} onToggle={onToggle} />
      ))}
    </ul>
  );
}

function RulesTreeNode({ node, depth, selected, onToggle }: {
  node: KnowledgeTreeNode;
  depth: number;
  selected: Set<string>;
  onToggle: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (node.kind === "folder") {
    return (
      <li>
        <div
          style={indent}
          className="flex items-center gap-1 py-0.5 cursor-pointer text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={12} className="text-zinc-400 dark:text-zinc-500 shrink-0" /> : <ChevronRight size={12} className="text-zinc-400 dark:text-zinc-500 shrink-0" />}
          {open ? <FolderOpen size={12} className="text-amber-500 shrink-0" /> : <Folder size={12} className="text-amber-500 shrink-0" />}
          <span className="text-xs truncate">{node.name}</span>
        </div>
        {open && node.children && (
          <ul>
            {node.children.map((c) => (
              <RulesTreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = selected.has(node.path);
  return (
    <li>
      <label
        style={indent}
        className="flex items-center gap-1.5 py-0.5 cursor-pointer rounded hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      >
        <span className="w-3 shrink-0" />
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggle(node.path)}
          className="shrink-0"
        />
        <FileIcon size={11} className="text-zinc-400 dark:text-zinc-500 shrink-0" />
        <span className={`text-xs truncate ${isSelected ? "text-amber-500 dark:text-amber-400" : "text-zinc-600 dark:text-zinc-300"}`}>
          {node.title || node.name}
        </span>
        <span className="text-[10px] text-zinc-400 dark:text-zinc-600 ml-auto font-mono truncate pl-2">{node.path}</span>
      </label>
    </li>
  );
}
