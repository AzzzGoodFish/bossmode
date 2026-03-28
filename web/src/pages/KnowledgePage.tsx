import { useState, useEffect } from "react";
import { BookOpen, Plus, ArrowLeft, Trash2, Shield, Pencil } from "lucide-react";
import type { KnowledgeBaseInfo, KnowledgeEntryInfo } from "../api/client";
import {
  getKnowledgeBases, createKnowledgeBase, deleteKnowledgeBase as apiDeleteKb,
  getKnowledgeEntries, addKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry as apiDeleteEntry,
} from "../api/client";
import { Markdown } from "../components/Markdown";
import { useDialog } from "../components/dialogs";

const inputCls = "w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-sm text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-600";

interface KnowledgePageProps {
  selectedKbId?: string | null;
  selectedEntryId?: string;
  onSelectKb?: (id: string | null) => void;
  onSelectEntry?: (kbId: string, entryId: string, entryTitle: string) => void;
}

export function KnowledgePage({ selectedKbId, selectedEntryId, onSelectKb, onSelectEntry }: KnowledgePageProps = {}) {
  const { toast } = useDialog();
  const [bases, setBases] = useState<KnowledgeBaseInfo[]>([]);
  const [selectedKb, setSelectedKb] = useState<string | null>(selectedKbId ?? null);
  const [showCreate, setShowCreate] = useState(selectedKbId === null);

  useEffect(() => {
    if (selectedKbId !== undefined) setSelectedKb(selectedKbId);
    if (selectedKbId === null) setShowCreate(true);
  }, [selectedKbId]);

  useEffect(() => {
    getKnowledgeBases().then(setBases).catch(console.error);
  }, []);

  const refresh = () => getKnowledgeBases().then(setBases).catch(console.error);

  if (selectedKb) {
    return <KnowledgeDetail kbId={selectedKb} selectedEntryId={selectedEntryId}
      onBack={() => { setSelectedKb(null); onSelectKb?.(null); refresh(); }}
      onSelectEntry={(entryId, title) => onSelectEntry?.(selectedKb, entryId, title)} />;
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-zinc-900 dark:text-white">Knowledge Bases</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{bases.length} knowledge bases</p>
        </div>
        <button onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg cursor-pointer">
          <Plus size={14} /> New Knowledge Base
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {bases.map((kb) => (
          <button key={kb.id} onClick={() => setSelectedKb(kb.id)}
            className="text-left bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors cursor-pointer">
            <div className="flex items-center gap-2 mb-2">
              <BookOpen size={14} className="text-zinc-500" />
              <span className="font-semibold text-zinc-900 dark:text-white text-sm">{kb.name}</span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{kb.description || "No description"}</p>
          </button>
        ))}
      </div>

      {showCreate && (
        <CreateKbDialog onClose={() => setShowCreate(false)} onCreate={async (name, desc) => {
          try { await createKnowledgeBase(name, desc); setShowCreate(false); refresh(); }
          catch (err: any) { toast(err.message, "error"); }
        }} />
      )}
    </div>
  );
}

function KnowledgeDetail({ kbId, selectedEntryId, onBack, onSelectEntry }: {
  kbId: string; selectedEntryId?: string; onBack: () => void; onSelectEntry?: (entryId: string, title: string) => void;
}) {
  const { toast, confirm } = useDialog();
  const [entries, setEntries] = useState<KnowledgeEntryInfo[]>([]);
  const [kbName, setKbName] = useState("");
  const [editEntry, setEditEntry] = useState<KnowledgeEntryInfo | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<"rule" | "knowledge">("knowledge");

  useEffect(() => {
    getKnowledgeEntries(kbId).then(setEntries).catch(console.error);
    getKnowledgeBases().then((bases) => {
      const kb = bases.find((b) => b.id === kbId);
      if (kb) setKbName(kb.name);
    }).catch(console.error);
  }, [kbId]);

  const refresh = () => getKnowledgeEntries(kbId).then(setEntries).catch(console.error);

  const handleDelete = async () => {
    if (!(await confirm("Delete this knowledge base and all entries?"))) return;
    try { await apiDeleteKb(kbId); onBack(); }
    catch (err: any) { toast(err.message, "error"); }
  };

  const rules = entries.filter((e) => e.type === "rule");
  const knowledge = entries.filter((e) => e.type !== "rule");

  // Entry preview mode
  const previewEntry = selectedEntryId ? entries.find((e) => e.id === selectedEntryId) : null;
  if (previewEntry) {
    const isRule = previewEntry.type === "rule";
    return (
      <div className="flex-1 flex flex-col p-6 overflow-y-auto">
        <div className="flex items-center justify-between mb-4 shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"><ArrowLeft size={18} /></button>
            {isRule && <Shield size={14} className="text-amber-500" />}
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-zinc-900 dark:text-white">{previewEntry.title}</h1>
                <span className={`text-xs px-1.5 py-0.5 rounded ${isRule ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                  {isRule ? "Rule" : "Knowledge"}
                </span>
              </div>
              <div className="text-xs text-zinc-500 mt-0.5">
                in {kbName || "Knowledge Base"} · by {previewEntry.source}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setEditEntry(previewEntry)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer">
              <Pencil size={14} /> Edit
            </button>
            <button onClick={async () => {
              if (!(await confirm("Delete this entry?"))) return;
              await apiDeleteEntry(kbId, previewEntry.id);
              refresh();
              onBack();
            }} className="flex items-center gap-1 px-3 py-1.5 text-red-500 dark:text-red-400 hover:text-red-400 dark:hover:text-red-300 text-sm cursor-pointer">
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </div>
        <div className="bg-white dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800 rounded-lg px-6 py-5 text-sm text-zinc-800 dark:text-zinc-300 leading-relaxed">
          <Markdown content={previewEntry.content} />
        </div>
        {editEntry && (
          <EntryDialog initial={editEntry} defaultType={previewEntry.type} onClose={() => setEditEntry(null)}
            onSave={async (title, content, type) => {
              try { await updateKnowledgeEntry(kbId, editEntry.id, title, content); setEditEntry(null); refresh(); }
              catch (err: any) { toast(err.message, "error"); }
            }} />
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"><ArrowLeft size={18} /></button>
          <h1 className="text-lg font-bold text-zinc-900 dark:text-white">Knowledge Base</h1>
          <span className="text-sm text-zinc-500">{entries.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleDelete} className="flex items-center gap-1 px-3 py-1.5 text-red-500 dark:text-red-400 hover:text-red-400 dark:hover:text-red-300 text-sm cursor-pointer">
            <Trash2 size={14} /> Delete KB
          </button>
          <button onClick={() => { setAddType("rule"); setShowAdd(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-sm font-medium rounded-lg cursor-pointer">
            <Shield size={14} /> Add Rule
          </button>
          <button onClick={() => { setAddType("knowledge"); setShowAdd(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg cursor-pointer">
            <Plus size={14} /> Add Knowledge
          </button>
        </div>
      </div>

      {rules.length > 0 && (
        <div className="mb-6">
          <h2 className="text-xs font-semibold text-amber-600 dark:text-amber-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Shield size={12} /> Rules ({rules.length})
          </h2>
          <div className="space-y-2">
            {rules.map((entry) => (
              <EntryCard key={entry.id} entry={entry} kbId={kbId} onEdit={() => setEditEntry(entry)} onRefresh={refresh} isRule
                onClick={() => onSelectEntry?.(entry.id, entry.title)} />
            ))}
          </div>
        </div>
      )}

      <div>
        {knowledge.length > 0 && (
          <h2 className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <BookOpen size={12} /> Knowledge ({knowledge.length})
          </h2>
        )}
        <div className="space-y-2">
          {knowledge.map((entry) => (
            <EntryCard key={entry.id} entry={entry} kbId={kbId} onEdit={() => setEditEntry(entry)} onRefresh={refresh}
              onClick={() => onSelectEntry?.(entry.id, entry.title)} />
          ))}
        </div>
      </div>

      {entries.length === 0 && (
        <div className="text-center text-zinc-400 dark:text-zinc-600 py-8 text-sm">No entries yet. Add rules or knowledge.</div>
      )}

      {(showAdd || editEntry) && (
        <EntryDialog
          initial={editEntry}
          defaultType={addType}
          onClose={() => { setShowAdd(false); setEditEntry(null); }}
          onSave={async (title, content, type) => {
            try {
              if (editEntry) {
                await updateKnowledgeEntry(kbId, editEntry.id, title, content);
              } else {
                await addKnowledgeEntry(kbId, title, content, type);
              }
              setShowAdd(false);
              setEditEntry(null);
              refresh();
            } catch (err: any) { toast(err.message, "error"); }
          }}
        />
      )}
    </div>
  );
}

function EntryCard({ entry, kbId, onEdit, onRefresh, isRule, onClick }: {
  entry: KnowledgeEntryInfo; kbId: string; onEdit: () => void; onRefresh: () => void; isRule?: boolean; onClick?: () => void;
}) {
  const { confirm } = useDialog();
  return (
    <div onClick={onClick}
      className={`bg-white dark:bg-zinc-900 border rounded-lg p-4 ${isRule ? "border-amber-300 dark:border-amber-900/50" : "border-zinc-200 dark:border-zinc-800"} ${onClick ? "cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors" : ""}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {isRule && <Shield size={12} className="text-amber-500" />}
          <span className="font-semibold text-zinc-900 dark:text-white text-sm">{entry.title}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 dark:text-zinc-600">by {entry.source}</span>
          <button onClick={onEdit} className="text-xs text-blue-500 dark:text-blue-400 hover:text-blue-400 dark:hover:text-blue-300 cursor-pointer">Edit</button>
          <button onClick={async () => {
            if (!(await confirm("Delete this entry?"))) return;
            await apiDeleteEntry(kbId, entry.id);
            onRefresh();
          }} className="text-xs text-red-500 dark:text-red-400 hover:text-red-400 dark:hover:text-red-300 cursor-pointer">Delete</button>
        </div>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{entry.content.slice(0, 200)}{entry.content.length > 200 ? "..." : ""}</p>
    </div>
  );
}

function CreateKbDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, desc: string) => void }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 w-full max-w-sm">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white mb-4">Create Knowledge Base</h2>
        <div className="space-y-3 mb-4">
          <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
            className={inputCls} autoFocus />
          <input autoComplete="off" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (optional)"
            className={inputCls} />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer">Cancel</button>
          <button onClick={() => name && onCreate(name, desc)} disabled={!name}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg cursor-pointer">Create</button>
        </div>
      </div>
    </div>
  );
}

function EntryDialog({ initial, defaultType, onClose, onSave }: {
  initial: KnowledgeEntryInfo | null; defaultType: "rule" | "knowledge"; onClose: () => void;
  onSave: (title: string, content: string, type: "rule" | "knowledge") => void;
}) {
  const [title, setTitle] = useState(initial?.title || "");
  const [content, setContent] = useState(initial?.content || "");
  const type = initial?.type || defaultType;
  const isRule = type === "rule";

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-5 w-full max-w-2xl">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-white mb-4 flex items-center gap-2">
          {isRule && <Shield size={14} className="text-amber-500" />}
          {initial ? `Edit ${isRule ? "Rule" : "Entry"}` : `Add ${isRule ? "Rule" : "Knowledge"}`}
        </h2>
        <div className="space-y-3 mb-4">
          <input autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title"
            className={inputCls} autoFocus />
          <textarea autoComplete="off" value={content} onChange={(e) => setContent(e.target.value)}
            placeholder={isRule ? "Rule content (markdown)..." : "Knowledge content..."}
            rows={14}
            className={`${inputCls} font-mono resize-none`} />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer">Cancel</button>
          <button onClick={() => title && content && onSave(title, content, type)} disabled={!title || !content}
            className={`px-4 py-2 text-white text-sm font-medium rounded-lg cursor-pointer ${
              isRule ? "bg-amber-700 hover:bg-amber-600 disabled:bg-zinc-200 dark:disabled:bg-zinc-700" : "bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700"
            }`}>
            {initial ? "Update" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
