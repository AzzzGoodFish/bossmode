import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import { useLongPress } from "../hooks/useLongPress";
import { MobileTopBar } from "../components/MobileTopBar";
import {
  Plus, Trash2, Pencil, FolderPlus, File as FileIcon, FileCode, Image as ImageIcon, Upload,
  Folder, FolderOpen, ChevronRight, ChevronDown,
  FolderInput, CheckSquare, X,
} from "lucide-react";
import type { KnowledgeEntry, KnowledgeTreeNode } from "../api/client";
import {
  getKnowledgeTree, getKnowledgeEntry, getKnowledgeRawBlob,
  addKnowledgeEntry, updateKnowledgeEntry, uploadKnowledgePng,
  deleteKnowledgeEntry as apiDeleteEntry,
  moveKnowledgeEntry, batchMoveKnowledge, batchDeleteKnowledge,
  getRooms,
} from "../api/client";
import { useDialog } from "../components/dialogs";
import { MoveToDialog } from "../components/MoveToDialog";
import { LibraryDocView, type LibraryDocKind } from "../components/LibraryDocView";
import { buildLibraryTreeGroups, visibleLibraryTreePaths } from "../utils/library-room-tree";
import { normalizeKnowledgeMarkdownRef } from "../utils/knowledge-path";
import { downloadFilename, triggerBlobDownload } from "../utils/download-file";
import { getLibraryFileFormat, type LibraryFileFormatInfo } from "../utils/library-file-format";
import { userActionError } from "../utils/user-error";

const inputCls = "w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors";

const WIDTH_STORAGE_KEY = "bossmode.knowledge.sidebarWidth";
const EXPANDED_STORAGE_KEY = "bossmode.knowledge.expandedFolders";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 160;
const MAX_WIDTH_RATIO = 0.5;

function getLibraryDocKind(path: string): LibraryDocKind {
  return getLibraryFileFormat(path).kind;
}

function canOpenLibraryFile(path: string): boolean {
  return /\.(md|markdown|html?|txt|json|png)$/i.test(path);
}

function basenameFromPath(path: string): string {
  return path.split("/").pop() || path;
}

function titleFromPath(path: string): string {
  const base = basenameFromPath(path);
  return base.replace(/\.[^.]+$/i, "").replace(/[-_]/g, " ");
}

interface KnowledgePageProps {
  initialPath?: string;
  onOpenMobileSidebar?: () => void;
}

export function KnowledgePage({ initialPath, onOpenMobileSidebar }: KnowledgePageProps = {}) {
  const { toast, confirm, prompt } = useDialog();
  const [tree, setTree] = useState<KnowledgeTreeNode | null>(null);
  const [rooms, setRooms] = useState<Awaited<ReturnType<typeof getRooms>>>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedPathOriginal, setSelectedPathOriginal] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);

  const [currentDoc, setCurrentDoc] = useState<KnowledgeEntry | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [isDocLoading, setIsDocLoading] = useState(false);
  const [markdownDirty, setMarkdownDirty] = useState(false);
  const loadDocSeqRef = useRef(0);
  const rawObjectUrlRef = useRef<string | null>(null);
  const pngUploadInputRef = useRef<HTMLInputElement | null>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: KnowledgeTreeNode } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const cancelRenameRef = useRef(false);
  const isMobile = useIsMobile();

  const [moveDialog, setMoveDialog] = useState<{ open: boolean; paths: string[]; currentPath?: string }>({
    open: false,
    paths: [],
  });
  const [dangerConfirmState, setDangerConfirmState] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);

  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [draggingPaths, setDraggingPaths] = useState<Set<string>>(new Set());

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

  const refreshRooms = useCallback(() => {
    getRooms().then(setRooms).catch(console.error);
  }, []);

  useEffect(() => { refreshTree(); }, [refreshTree]);
  useEffect(() => { refreshRooms(); }, [refreshRooms]);
  useEffect(() => () => {
    if (rawObjectUrlRef.current) URL.revokeObjectURL(rawObjectUrlRef.current);
  }, []);

  useEffect(() => {
    if (!initialPath || initialPath === "__new__") return;
    const normalized = normalizeKnowledgeMarkdownRef(initialPath);
    const normalizedPath = normalized.path;
    const topLevel = normalizedPath.split("/")[0];
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(topLevel);
      return next;
    });
    if (canOpenLibraryFile(normalizedPath)) {
      setSelectedPath(normalizedPath);
      setSelectedPathOriginal(normalized.changed ? normalized.originalPath : null);
      setSelectedPaths(new Set());
    } else {
      setSelectedPath(null);
      setSelectedPathOriginal(null);
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
    const seq = ++loadDocSeqRef.current;
    if (!selectedPath) {
      setCurrentDoc(null);
      setDraftTitle("");
      setMarkdownDirty(false);
      setIsDocLoading(false);
      return;
    }

    setCurrentDoc(null);
    setDraftTitle("");
    setMarkdownDirty(false);
    if (rawObjectUrlRef.current) {
      URL.revokeObjectURL(rawObjectUrlRef.current);
      rawObjectUrlRef.current = null;
    }

    setIsDocLoading(true);
    const load = getLibraryDocKind(selectedPath) === "png"
      ? getKnowledgeRawBlob(selectedPath).then((blob) => {
          const url = URL.createObjectURL(blob);
          rawObjectUrlRef.current = url;
          return {
            id: selectedPath,
            title: titleFromPath(selectedPath),
            content: url,
            source: "user",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        })
      : getKnowledgeEntry(selectedPath);
    load.then((doc) => {
      if (seq !== loadDocSeqRef.current) {
        if (getLibraryDocKind(doc.id) === "png" && doc.content) URL.revokeObjectURL(doc.content);
        return;
      }
      setCurrentDoc(doc);
      setDraftTitle(doc.title);
      setIsDocLoading(false);
    }).catch((err) => {
      if (seq !== loadDocSeqRef.current) return;
      const base = String(err?.message || err);
      const message = selectedPathOriginal
        ? `${base}: ${selectedPathOriginal} (tried ${selectedPath})`
        : base;
      toast(message, "error");
      setCurrentDoc(null);
      setIsDocLoading(false);
    });
  }, [selectedPath, selectedPathOriginal, toast]);

  const folderNode = useMemo(() => {
    if (!tree || !initialPath || initialPath === "__new__") return null;
    const normalizedPath = normalizeKnowledgeMarkdownRef(initialPath).path;
    if (canOpenLibraryFile(normalizedPath)) return null;
    if (selectedPath) return null;
    return findNodeByPath(tree, normalizedPath);
  }, [tree, initialPath, selectedPath]);

  // mobileView must be declared AFTER folderNode (dependency order — avoids TDZ)
  const mobileView = useMemo(() => {
    if (!isMobile) return "both";
    return (currentDoc || folderNode) ? "doc" : "tree";
  }, [isMobile, currentDoc, folderNode]);

  useEffect(() => {
    if (!initialPath || initialPath === "__new__") return;
    const normalizedPath = normalizeKnowledgeMarkdownRef(initialPath).path;
    if (normalizedPath.endsWith(".md")) return;
    const topLevel = normalizedPath.split("/")[0];
    const el = document.querySelector(`[data-folder-path="${topLevel}"]`) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.add("folder-pulse");
    const timer = setTimeout(() => el.classList.remove("folder-pulse"), 1000);
    return () => clearTimeout(timer);
  }, [initialPath, tree]);

  useEffect(() => {
    if (!contextMenu) return;
    const onClose = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContextMenu(null);
    };
    window.addEventListener("mousedown", onClose);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClose);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const libraryGroups = useMemo(() => buildLibraryTreeGroups(rooms, tree), [rooms, tree]);

  const visiblePaths = useMemo(() => visibleLibraryTreePaths(libraryGroups, expanded), [expanded, libraryGroups]);

  const handleCreateDoc = async (parentPath: string) => {
    const title = await prompt("New document title", "");
    if (!title) return;
    const filename = title.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\-.\u4e00-\u9fff]/gu, "") + ".md";
    const path = parentPath ? `${parentPath}/${filename}` : filename;
    try {
      await addKnowledgeEntry(title, "", path);
      refreshTree();
      if (parentPath) setExpanded((prev) => new Set(prev).add(parentPath));
      setSelectedPathOriginal(null);
      setSelectedPath(path);
      setSelectedPaths(new Set());
    } catch (err) { console.error("Failed to create Library document", err); toast(userActionError("create this document", "Check the title and folder, then try again."), "error"); }
  };

  const handleCreateFolder = async (parentPath: string) => {
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
    } catch (err) { console.error("Failed to create Library folder", err); toast(userActionError("create this folder", "Check the name, then try again."), "error"); }
  };

  const handleUploadPng = async (file: File | null, parentPath = "") => {
    if (!file) return;
    const safeName = file.name.toLowerCase().replace(/\s+/g, "-").replace(/[^\w\-.\u4e00-\u9fff]/gu, "");
    const fallback = safeName.endsWith(".png") ? safeName : `${safeName || "image"}.png`;
    const path = await prompt("PNG path", parentPath ? `${parentPath}/${fallback}` : fallback);
    if (!path) return;
    try {
      const entry = await uploadKnowledgePng(path, file);
      refreshTree();
      setSelectedPathOriginal(null);
      setSelectedPath(entry.id);
      setSelectedPaths(new Set());
    } catch (err) { console.error("Failed to upload Library image", err); toast(userActionError("upload this image", "Check the file and path, then try again."), "error"); }
  };

  const handleDownloadDoc = async (doc: KnowledgeEntry) => {
    try {
      const blob = await getKnowledgeRawBlob(doc.id);
      triggerBlobDownload(blob, downloadFilename(doc.id, doc.title || "document"));
    } catch (err) {
      console.error("Failed to download Library document", err);
      toast(userActionError("download this document"), "error");
    }
  };

  const confirmDanger = (message: string): Promise<boolean> => new Promise((resolve) => {
    setDangerConfirmState({ message, resolve });
  });

  const confirmDiscardMarkdown = useCallback(async () => {
    if (!markdownDirty) return true;
    return confirm("Discard unsaved markdown changes?");
  }, [confirm, markdownDirty]);

  useEffect(() => {
    if (!markdownDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [markdownDirty]);

  const selectDocument = useCallback(async (path: string) => {
    if (!(await confirmDiscardMarkdown())) return;
    setSelectedPaths(new Set());
    setSelectedPathOriginal(null);
    setSelectedPath(path);
  }, [confirmDiscardMarkdown]);

  const clearDocumentSelection = useCallback(async () => {
    if (!(await confirmDiscardMarkdown())) return;
    setSelectedPath(null);
    setSelectedPathOriginal(null);
    setCurrentDoc(null);
  }, [confirmDiscardMarkdown]);

  const handleDeleteDoc = async () => {
    if (!currentDoc) return;
    if (!(await confirmDanger(`Delete "${currentDoc.title}"?`))) return;
    try {
      await apiDeleteEntry(currentDoc.id);
      refreshTree();
      setSelectedPath(null);
      setSelectedPathOriginal(null);
    } catch (err) { console.error("Failed to delete Library document", err); toast(userActionError("delete this document"), "error"); }
  };

  const handleDeletePath = async (path: string) => {
    if (!(await confirmDanger(`Delete "${path}"?`))) return;
    try {
      await apiDeleteEntry(path);
      refreshTree();
      if (selectedPath === path || selectedPath?.startsWith(`${path}/`)) {
        setSelectedPath(null);
        setSelectedPathOriginal(null);
      }
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    } catch (err: any) {
      toast(String(err?.message || err), "error");
    }
  };



  const moveSingle = useCallback(async (fromPath: string, destination: string) => {
    const base = fromPath.split("/").pop() || fromPath;
    const to = destination ? `${destination}/${base}` : base;
    if (to === fromPath) return;
    const moved = await moveKnowledgeEntry(fromPath, to);

    if (selectedPath === fromPath) {
      setSelectedPathOriginal(null);
      setSelectedPath(moved.to);
    } else if (selectedPath?.startsWith(`${fromPath}/`)) {
      setSelectedPathOriginal(null);
      setSelectedPath(moved.to + selectedPath.slice(fromPath.length));
    }
  }, [selectedPath]);

  const openMoveDialogFor = (paths: string[], currentPath?: string) => {
    setMoveDialog({ open: true, paths, currentPath });
  };

  const handleMoveConfirm = async (destination: string) => {
    const paths = moveDialog.paths;
    if (paths.length === 0) {
      setMoveDialog({ open: false, paths: [] });
      return;
    }

    const valid = paths.filter((p) => destination !== p && !destination.startsWith(`${p}/`));
    if (valid.length === 0) {
      setMoveDialog({ open: false, paths: [] });
      return;
    }

    try {
      if (valid.length === 1) {
        await moveSingle(valid[0], destination);
      } else {
        const result = await batchMoveKnowledge(valid, destination);
        if (result.failed.length > 0) {
          toast(`Moved ${result.moved}. Failed ${result.failed.length}.`, "info");
        }
      }
      setSelectedPaths(new Set());
      setMoveDialog({ open: false, paths: [] });
      refreshTree();
    } catch (err: any) {
      toast(String(err?.message || err), "error");
    }
  };

  const handleBatchDelete = async () => {
    const paths = [...selectedPaths];
    if (paths.length === 0) return;
    if (!(await confirmDanger(`Delete ${paths.length} selected item(s)?`))) return;
    try {
      const result = await batchDeleteKnowledge(paths);
      if (result.failed.length > 0) {
        toast(`Deleted ${result.deleted}. Failed ${result.failed.length}.`, "info");
      }
      setSelectedPaths(new Set());
      const removesSelectedPath = selectedPath ? paths.some((p) => selectedPath === p || selectedPath.startsWith(`${p}/`)) : false;
      if (removesSelectedPath) {
        setSelectedPath(null);
        setSelectedPathOriginal(null);
      }
      refreshTree();
    } catch (err: any) {
      toast(String(err?.message || err), "error");
    }
  };

  const handleStartRename = (path: string | null) => {
    setRenamingPath(path);
    setContextMenu(null);
  };

  const handleConfirmRename = async (node: KnowledgeTreeNode, rawName: string) => {
    const newName = rawName.trim();
    if (!newName) {
      setRenamingPath(null);
      return;
    }

    const oldPath = node.path;
    const parts = oldPath.split("/");
    const oldBase = parts.pop() || "";
    const parent = parts.join("/");
    const oldExt = oldBase.includes(".") ? oldBase.slice(oldBase.lastIndexOf(".")) : ".md";
    const finalBase = node.kind === "file"
      ? (newName.includes(".") ? newName : `${newName}${oldExt}`)
      : newName;

    if (finalBase === oldBase) {
      setRenamingPath(null);
      return;
    }

    const nextPath = parent ? `${parent}/${finalBase}` : finalBase;
    try {
      const moved = await moveKnowledgeEntry(oldPath, nextPath);
      setRenamingPath(null);
      if (selectedPath === oldPath) {
        setSelectedPathOriginal(null);
        setSelectedPath(moved.to);
      } else if (selectedPath?.startsWith(`${oldPath}/`)) {
        setSelectedPathOriginal(null);
        setSelectedPath(moved.to + selectedPath.slice(oldPath.length));
      }
      refreshTree();
    } catch (err: any) {
      toast(String(err?.message || err), "error");
      setRenamingPath(null);
    }
  };

  const toggleSelectPath = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const rangeSelect = (fromPath: string, toPath: string) => {
    const a = visiblePaths.indexOf(fromPath);
    const b = visiblePaths.indexOf(toPath);
    if (a < 0 || b < 0) return;
    const [start, end] = a <= b ? [a, b] : [b, a];
    const selection = new Set(selectedPaths);
    for (let i = start; i <= end; i++) selection.add(visiblePaths[i]);
    setSelectedPaths(selection);
  };

  const handleNodeClick = async (e: React.MouseEvent, node: KnowledgeTreeNode) => {
    const multiMode = e.ctrlKey || e.metaKey || e.shiftKey;

    if (node.kind === "folder") {
      if (!multiMode) {
        toggleExpanded(node.path);
        return;
      }
    }

    if (e.shiftKey && lastClickedRef.current) {
      rangeSelect(lastClickedRef.current, node.path);
    } else if (e.ctrlKey || e.metaKey) {
      toggleSelectPath(node.path);
    } else {
      if (node.kind === "file") await selectDocument(node.path);
      else setSelectedPaths(new Set());
    }

    lastClickedRef.current = node.path;
  };

  const handleContextMenu = (e: React.MouseEvent, node: KnowledgeTreeNode) => {
    e.preventDefault();
    const menuW = 180;
    const menuH = 128;
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
    setContextMenu({ x, y, node });
  };

  const handleDragStart = (e: React.DragEvent, node: KnowledgeTreeNode) => {
    const paths = selectedPaths.size > 0 && selectedPaths.has(node.path)
      ? [...selectedPaths]
      : [node.path];
    setDraggingPaths(new Set(paths));
    e.dataTransfer.setData("application/json", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDrop = async (e: React.DragEvent, targetFolder: KnowledgeTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    setDraggingPaths(new Set());

    let paths: string[] = [];
    try {
      paths = JSON.parse(e.dataTransfer.getData("application/json"));
    } catch {
      return;
    }

    const valid = paths.filter((p) => p !== targetFolder.path && !targetFolder.path.startsWith(`${p}/`));
    if (valid.length === 0) return;

    try {
      if (valid.length === 1) {
        await moveSingle(valid[0], targetFolder.path);
      } else {
        const result = await batchMoveKnowledge(valid, targetFolder.path);
        if (result.failed.length > 0) {
          toast(`Moved ${result.moved}. Failed ${result.failed.length}.`, "info");
        }
      }
      setSelectedPaths(new Set());
      refreshTree();
    } catch (err: any) {
      toast(String(err?.message || err), "error");
    }
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
    setSidebarWidth((w) => {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(w));
      return w;
    });
  };

  const excludePaths = moveDialog.paths;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title="Knowledge" onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="hidden md:flex items-center justify-between px-6 pt-5 pb-3 shrink-0 border-b border-line-soft">
        <div>
          <h1 className="text-lg font-bold text-ink-1">Library</h1>
          <p className="text-xs text-ink-3 mt-0.5">
            Markdown documents organized by room. Edit source, save explicitly, and preview rendered output.
          </p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <aside
          style={{ width: isMobile ? undefined : `${sidebarWidth}px` }}
          className={`${isMobile ? (mobileView === "tree" ? "flex-1" : "hidden") : "shrink-0"} border-r border-line-soft overflow-y-auto bg-surface-1/50 flex flex-col`}
        >
          <div className="px-3 pt-3 pb-2 flex items-center justify-between sticky top-0 bg-surface-1/90 backdrop-blur-sm z-10">
            <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Documents</span>
            <div className="flex items-center gap-1">
              <input
                ref={pngUploadInputRef}
                type="file"
                accept="image/png"
                className="hidden"
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0] || null;
                  e.currentTarget.value = "";
                  void handleUploadPng(file);
                }}
              />
              <button title="Upload PNG at root" onClick={() => pngUploadInputRef.current?.click()}
                className="p-1 text-ink-3 hover:text-ink-1 cursor-pointer">
                <Upload size={14} />
              </button>
              <button title="New folder at root" onClick={() => handleCreateFolder("")}
                className="p-1 text-ink-3 hover:text-ink-1 cursor-pointer">
                <FolderPlus size={14} />
              </button>
              <button title="New document at root" onClick={() => handleCreateDoc("")}
                className="p-1 text-ink-3 hover:text-ink-1 cursor-pointer">
                <Plus size={14} />
              </button>
            </div>
          </div>

          {selectedPaths.size > 0 && (
            <div className="px-3 py-2 border-y border-line-soft bg-surface-2/50 flex items-center justify-between text-xs">
              <span className="text-ink-2 font-medium flex items-center gap-1">
                <CheckSquare size={12} /> {selectedPaths.size} selected
              </span>
              <div className="flex items-center gap-2">
                <button onClick={() => openMoveDialogFor([...selectedPaths])} className="text-ink-3 hover:text-ink-1 cursor-pointer">
                  Move to...
                </button>
                <button onClick={handleBatchDelete} className="text-blocked hover:opacity-80 cursor-pointer">
                  Delete
                </button>
                <button onClick={() => setSelectedPaths(new Set())} className="text-ink-3 hover:text-ink-2 cursor-pointer">
                  <X size={12} />
                </button>
              </div>
            </div>
          )}

          {tree ? (() => {
            const sharedTreeProps = {
              selectedPath, selectedPaths, expanded, renamingPath, draggingPaths, dragOverPath, isMobile,
              onToggle: toggleExpanded,
              onNodeClick: handleNodeClick,
              onCreateDoc: handleCreateDoc,
              onCreateFolder: handleCreateFolder,
              onContextMenu: handleContextMenu,
              onStartRename: handleStartRename,
              onConfirmRename: handleConfirmRename,
              onDeletePath: handleDeletePath,
              onDragStart: handleDragStart,
              onDragOver: (e: React.DragEvent, node: KnowledgeTreeNode) => {
                if (node.kind !== "folder") return;
                e.preventDefault(); e.stopPropagation();
                setDragOverPath(node.path);
              },
              onDragLeave: (e: React.DragEvent, node: KnowledgeTreeNode) => {
                if (node.kind !== "folder") return;
                e.stopPropagation();
                if (dragOverPath === node.path) setDragOverPath(null);
              },
              onDrop: handleDrop,
              onDragEnd: () => { setDraggingPaths(new Set()); setDragOverPath(null); },
              cancelRenameRef,
            };
            return (
              <div className="pb-4">
                {libraryGroups.map((group) => (
                  <div key={group.id}>
                    <div className="group/room flex items-center justify-between gap-1.5 px-3 pt-3 pb-1">
                      <span className="text-[10px] font-semibold tracking-[0.06em] text-ink-4 uppercase truncate" title={group.rootPath || "docs root"}>{group.label}</span>
                      <span className="opacity-0 group-hover/room:opacity-100 flex items-center gap-0.5 transition-opacity shrink-0">
                        <button title={`New folder in ${group.label}`} onClick={() => handleCreateFolder(group.rootPath)}
                          className="p-0.5 text-ink-3 hover:text-ink-1 cursor-pointer">
                          <FolderPlus size={12} />
                        </button>
                        <button title={`New document in ${group.label}`} onClick={() => handleCreateDoc(group.rootPath)}
                          className="p-0.5 text-ink-3 hover:text-ink-1 cursor-pointer">
                          <Plus size={12} />
                        </button>
                      </span>
                    </div>
                    {group.nodes.length > 0 ? (
                      <TreeView nodes={group.nodes} {...sharedTreeProps} />
                    ) : (
                      <div className="pl-3 pr-3 py-1 text-[11px] text-ink-4">{group.isGlobal ? "no unfiled documents" : "no documents"}</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })() : (
            <div className="px-3 py-8 text-center text-xs text-ink-4">
              Loading documents…
            </div>
          )}
        </aside>

        {!isMobile && (
          <div
            onMouseDown={onDragStart}
            className="w-1 shrink-0 cursor-col-resize bg-transparent hover:opacity-90/40 transition-colors"
            title="Drag to resize"
          />
        )}

        <main className={`${isMobile ? (mobileView === "doc" ? "flex-1" : "hidden") : "flex-1"} overflow-y-auto`}>
          {isMobile && mobileView === "doc" && (
            <button
              onClick={() => { void clearDocumentSelection(); }}
              className="md:hidden flex items-center gap-1 px-4 py-2.5 text-sm text-ink-2 hover:text-ink-1 border-b border-line-soft w-full cursor-pointer"
            >
              ← Back
            </button>
          )}
          {currentDoc ? (
            <LibraryDocView
              key={currentDoc.id}
              doc={{ path: selectedPath || currentDoc.id, title: basenameFromPath(currentDoc.id), kind: getLibraryDocKind(currentDoc.id), content: currentDoc.content, meta: `${currentDoc.id} · by ${currentDoc.source}`, readOnly: getLibraryDocKind(currentDoc.id) === "png" }}
              onSave={async (content) => {
                try {
                  const updated = await updateKnowledgeEntry(currentDoc.id, draftTitle || currentDoc.title, content);
                  setCurrentDoc(updated); setDraftTitle(updated.title); refreshTree();
                } catch (err) { console.error("Failed to save Library document", err); toast(userActionError("save this document"), "error"); }
              }}
              onRenameTitle={(t) => {
                setDraftTitle(t);
                updateKnowledgeEntry(currentDoc.id, t, currentDoc.content)
                  .then((updated) => { setCurrentDoc(updated); refreshTree(); })
                  .catch((err) => { console.error("Failed to rename Library document", err); toast(userActionError("rename this document"), "error"); });
              }}
              onDownload={() => { void handleDownloadDoc(currentDoc); }}
              onDelete={handleDeleteDoc}
              onDirtyChange={setMarkdownDirty}
            />
          ) : isDocLoading ? (
            <div className="h-full flex items-center justify-center text-sm text-ink-4">
              Loading document…
            </div>
          ) : folderNode ? (
            <FolderOverview
              node={folderNode}
              onSelectDoc={(path) => {
                void selectDocument(path);
              }}
              onCreateDoc={() => handleCreateDoc(folderNode.path)}
              onCreateFolder={() => handleCreateFolder(folderNode.path)}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-ink-4">
              Select a document from the tree to view it.
            </div>
          )}
        </main>
      </div>

      {contextMenu && (
        <ContextMenuOverlay x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <ContextMenuItem icon={<FolderInput size={14} />} label="Move to..." onClick={() => {
            const path = contextMenu.node.path;
            const parent = path.split("/").slice(0, -1).join("/");
            openMoveDialogFor([path], parent);
            setContextMenu(null);
          }} />
          <ContextMenuItem icon={<Pencil size={14} />} label="Rename" onClick={() => handleStartRename(contextMenu.node.path)} />
          <div className="h-px my-1 bg-surface-3" />
          <ContextMenuItem icon={<Trash2 size={14} />} label="Delete" danger onClick={() => {
            void handleDeletePath(contextMenu.node.path);
            setContextMenu(null);
          }} />
        </ContextMenuOverlay>
      )}

      <MoveToDialog
        open={moveDialog.open}
        tree={tree}
        itemCount={moveDialog.paths.length}
        currentPath={moveDialog.currentPath}
        excludePaths={excludePaths}
        onConfirm={handleMoveConfirm}
        onCancel={() => setMoveDialog({ open: false, paths: [] })}
      />

      {dangerConfirmState && (
        <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center" onClick={() => {
          dangerConfirmState.resolve(false);
          setDangerConfirmState(null);
        }}>
          <div
            className="w-full max-w-sm bg-surface-1 border border-line rounded-lg shadow-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm text-ink-1 mb-5 whitespace-pre-wrap">{dangerConfirmState.message}</p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  dangerConfirmState.resolve(false);
                  setDangerConfirmState(null);
                }}
                className="px-4 py-2 text-sm text-ink-3 hover:text-ink-1 cursor-pointer"
              >
                Cancel
              </button>
              <button
                autoFocus
                onClick={() => {
                  dangerConfirmState.resolve(true);
                  setDangerConfirmState(null);
                }}
                className="px-4 py-2 text-sm font-medium rounded-lg text-white bg-blocked hover:opacity-90 cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TreeView({
  nodes,
  selectedPath,
  selectedPaths,
  expanded,
  renamingPath,
  draggingPaths,
  dragOverPath,
  isMobile,
  onToggle,
  onNodeClick,
  onCreateDoc,
  onCreateFolder,
  onContextMenu,
  onStartRename,
  onConfirmRename,
  onDeletePath,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  cancelRenameRef,
}: {
  nodes: KnowledgeTreeNode[];
  selectedPath: string | null;
  selectedPaths: Set<string>;
  expanded: Set<string>;
  renamingPath: string | null;
  draggingPaths: Set<string>;
  dragOverPath: string | null;
  isMobile: boolean;
  onToggle: (path: string) => void;
  onNodeClick: (e: React.MouseEvent, node: KnowledgeTreeNode) => void;
  onCreateDoc: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onContextMenu: (e: React.MouseEvent, node: KnowledgeTreeNode) => void;
  onStartRename: (path: string | null) => void;
  onConfirmRename: (node: KnowledgeTreeNode, rawName: string) => void;
  onDeletePath: (path: string) => void;
  onDragStart: (e: React.DragEvent, node: KnowledgeTreeNode) => void;
  onDragOver: (e: React.DragEvent, node: KnowledgeTreeNode) => void;
  onDragLeave: (e: React.DragEvent, node: KnowledgeTreeNode) => void;
  onDrop: (e: React.DragEvent, targetFolder: KnowledgeTreeNode) => void;
  onDragEnd: () => void;
  cancelRenameRef: React.MutableRefObject<boolean>;
}) {
  return (
    <ul className="text-sm pb-4">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          selectedPaths={selectedPaths}
          expanded={expanded}
          renamingPath={renamingPath}
          draggingPaths={draggingPaths}
          dragOverPath={dragOverPath}
          isMobile={isMobile}
          onToggle={onToggle}
          onNodeClick={onNodeClick}
          onCreateDoc={onCreateDoc}
          onCreateFolder={onCreateFolder}
          onContextMenu={onContextMenu}
          onStartRename={onStartRename}
          onConfirmRename={onConfirmRename}
          onDeletePath={onDeletePath}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          cancelRenameRef={cancelRenameRef}
        />
      ))}
    </ul>
  );
}

function LibraryFileIcon({ format, size = 12 }: { format: LibraryFileFormatInfo; size?: number }) {
  if (format.kind === "html") return <FileCode size={size} className="text-think shrink-0" />;
  if (format.kind === "png") return <ImageIcon size={size} className="text-onair shrink-0" />;
  return <FileIcon size={size} className="text-ink-4 shrink-0" />;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  selectedPaths,
  expanded,
  renamingPath,
  draggingPaths,
  dragOverPath,
  isMobile,
  onToggle,
  onNodeClick,
  onCreateDoc,
  onCreateFolder,
  onContextMenu,
  onStartRename,
  onConfirmRename,
  onDeletePath,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  cancelRenameRef,
}: {
  node: KnowledgeTreeNode;
  depth: number;
  selectedPath: string | null;
  selectedPaths: Set<string>;
  expanded: Set<string>;
  renamingPath: string | null;
  draggingPaths: Set<string>;
  dragOverPath: string | null;
  isMobile: boolean;
  onToggle: (path: string) => void;
  onNodeClick: (e: React.MouseEvent, node: KnowledgeTreeNode) => void;
  onCreateDoc: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onContextMenu: (e: React.MouseEvent, node: KnowledgeTreeNode) => void;
  onStartRename: (path: string | null) => void;
  onConfirmRename: (node: KnowledgeTreeNode, rawName: string) => void;
  onDeletePath: (path: string) => void;
  onDragStart: (e: React.DragEvent, node: KnowledgeTreeNode) => void;
  onDragOver: (e: React.DragEvent, node: KnowledgeTreeNode) => void;
  onDragLeave: (e: React.DragEvent, node: KnowledgeTreeNode) => void;
  onDrop: (e: React.DragEvent, targetFolder: KnowledgeTreeNode) => void;
  onDragEnd: () => void;
  cancelRenameRef: React.MutableRefObject<boolean>;
}) {
  // depth 0 aligns with the room-group header (px-3 = 12px); each level steps 12px.
  const indent = { paddingLeft: `${depth * 12 + 12}px` };
  const openedSelected = selectedPath === node.path;
  const multiSelected = selectedPaths.has(node.path);
  const isDragging = draggingPaths.has(node.path);
  const isDropTarget = dragOverPath === node.path;

  // Mobile: long press opens context menu (right-click replacement)
  const lp = useLongPress({
    onLongPress: (e: React.TouchEvent) => {
      const touch = e.touches[0];
      onContextMenu({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} } as unknown as React.MouseEvent, node);
    },
  });

  const rowBase = "group relative flex items-center justify-between py-2.5 md:py-1 pr-1 cursor-pointer";
  const rowSelect = openedSelected
    ? "bg-accent-dim text-accent-ink"
    : multiSelected
      ? "bg-accent-dim text-ink-1 before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-accent"
      : "text-ink-2 hover:bg-surface-2/60";
  const dropCls = isDropTarget ? "outline outline-2 outline-accent outline-offset-[-1px] bg-accent-dim" : "";

  if (node.kind === "folder") {
    const isOpen = expanded.has(node.path);
    return (
      <li>
        <div style={indent}
          data-folder-path={node.path}
          draggable={!isMobile}
          onDragStart={isMobile ? undefined : (e) => onDragStart(e, node)}
          onDragEnd={isMobile ? undefined : onDragEnd}
          onDragOver={isMobile ? undefined : (e) => onDragOver(e, node)}
          onDragLeave={isMobile ? undefined : (e) => onDragLeave(e, node)}
          onDrop={isMobile ? undefined : (e) => onDrop(e, node)}
          onContextMenu={(e) => onContextMenu(e, node)}
          onClick={(e) => onNodeClick(e, node)}
          {...(isMobile ? lp : {})}
          className={`${rowBase} ${rowSelect} ${dropCls} ${isDragging ? "opacity-40" : ""}`}
        >
          <span className="flex items-center gap-1 text-ink-2 min-w-0">
            {isOpen ? <ChevronDown size={12} className="text-ink-4 shrink-0" /> : <ChevronRight size={12} className="text-ink-4 shrink-0" />}
            {isOpen
              ? <FolderOpen size={13} className="text-think shrink-0" />
              : <Folder size={13} className="text-think shrink-0" />}
            {renamingPath === node.path ? (
              <input
                autoFocus
                defaultValue={node.name}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  if (cancelRenameRef.current) {
                    cancelRenameRef.current = false;
                    return;
                  }
                  onConfirmRename(node, e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRenameRef.current = true;
                    onStartRename(null);
                  }
                }}
                className="text-xs bg-transparent border border-accent rounded px-1 py-0.5 outline-none w-full min-w-0"
              />
            ) : (
              <span className="font-medium text-xs truncate" onDoubleClick={() => onStartRename(node.path)}>{node.name}</span>
            )}
          </span>
          <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 transition-opacity shrink-0">
            <button title="New folder" onClick={(e) => { e.stopPropagation(); onCreateFolder(node.path); }}
              className="p-0.5 text-ink-3 hover:text-ink-1 cursor-pointer">
              <FolderPlus size={12} />
            </button>
            <button title="New document" onClick={(e) => { e.stopPropagation(); onCreateDoc(node.path); }}
              className="p-0.5 text-ink-3 hover:text-ink-1 cursor-pointer">
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
                selectedPaths={selectedPaths}
                expanded={expanded}
                renamingPath={renamingPath}
                draggingPaths={draggingPaths}
                dragOverPath={dragOverPath}
                isMobile={isMobile}
                onToggle={onToggle}
                onNodeClick={onNodeClick}
                onCreateDoc={onCreateDoc}
                onCreateFolder={onCreateFolder}
                onContextMenu={onContextMenu}
                onStartRename={onStartRename}
                onConfirmRename={onConfirmRename}
                onDeletePath={onDeletePath}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                onDragEnd={onDragEnd}
                cancelRenameRef={cancelRenameRef}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const fileFormat = getLibraryFileFormat(node.path);

  return (
    <li>
      <div style={indent}
        draggable={!isMobile}
        onDragStart={isMobile ? undefined : (e) => onDragStart(e, node)}
        onDragEnd={isMobile ? undefined : onDragEnd}
        onContextMenu={(e) => onContextMenu(e, node)}
        onClick={(e) => onNodeClick(e, node)}
        {...(isMobile ? lp : {})}
        className={`${rowBase} ${rowSelect} ${isDragging ? "opacity-40" : ""}`}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="w-3 shrink-0" />
          <LibraryFileIcon format={fileFormat} size={12} />
          {renamingPath === node.path ? (
            <input
              autoFocus
              defaultValue={(node.name || "").replace(/\.md$/i, "")}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                if (cancelRenameRef.current) {
                  cancelRenameRef.current = false;
                  return;
                }
                onConfirmRename(node, e.currentTarget.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelRenameRef.current = true;
                  onStartRename(null);
                }
              }}
              className="text-xs bg-transparent border border-accent rounded px-1 py-0.5 outline-none w-full min-w-0"
            />
          ) : (
            <>
              <span className="text-xs truncate font-mono" title={`${node.path} · ${fileFormat.description}`} onDoubleClick={() => onStartRename(node.path)}>
                {node.name}
              </span>
            </>
          )}
        </span>
      </div>
    </li>
  );
}

function ContextMenuOverlay({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        className="absolute min-w-[170px] bg-surface-1 border border-line rounded-lg shadow-lg p-1"
        style={{ left: `${x}px`, top: `${y}px` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function ContextMenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded cursor-pointer ${danger
        ? "text-blocked hover:bg-blocked-dim"
        : "text-ink-2 hover:bg-surface-2"}`}
    >
      {icon}
      {label}
    </button>
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
            <Folder size={20} className="text-ink-3 shrink-0" />
            <h2 className="text-lg font-bold text-ink-1 truncate">{node.name}</h2>
          </div>
          <div className="text-xs text-ink-3">
            {totalDocs} document{totalDocs !== 1 ? "s" : ""}
            {subfolders.length > 0 && ` · ${subfolders.length} subfolder${subfolders.length !== 1 ? "s" : ""}`}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onCreateFolder}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border border-line rounded text-ink-2 hover:text-ink-1 hover:border-line-strong cursor-pointer"
          >
            <FolderPlus size={14} /> New folder
          </button>
          <button
            onClick={onCreateDoc}
            className="flex items-center gap-1 px-3 py-1.5 bg-accent text-accent-contrast hover:opacity-90 text-sm rounded cursor-pointer"
          >
            <Plus size={14} /> New document
          </button>
        </div>
      </div>

      {rootDocs.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider mb-2">Documents</div>
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
        <div className="text-center py-12 text-sm text-ink-4">
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
        <div className="text-[11px] font-semibold text-ink-3 uppercase tracking-wider">{node.name}</div>
        <span className="text-[10px] text-ink-4 tabular-nums">{docs.length}</span>
      </div>
      <div className="space-y-1">
        {visible.map((doc) => (
          <DocRow key={doc.path} node={doc} onClick={() => onSelectDoc(doc.path)} />
        ))}
        {shouldCollapse && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="text-xs text-ink-3 hover:text-ink-2 px-3 py-1.5 cursor-pointer"
          >
            Show {docs.length - 3} more…
          </button>
        )}
      </div>
    </div>
  );
}

function DocRow({ node, onClick }: { node: KnowledgeTreeNode; onClick: () => void }) {
  const format = getLibraryFileFormat(node.path);
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center gap-2 px-3 py-2 rounded border border-transparent hover:border-line-soft hover:bg-surface-2/50 transition-colors cursor-pointer group"
      title={`${node.path} · ${format.description}`}
    >
      <LibraryFileIcon format={format} size={14} />
      <span className="text-sm text-ink-2 group-hover:text-ink-1 truncate min-w-0 flex-1 font-mono">
        {node.name}
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
