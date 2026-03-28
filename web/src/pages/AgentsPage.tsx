import { useState, useEffect } from "react";
import { Bot, Plus, Search } from "lucide-react";
import type { AgentInfo } from "../api/client";
import { getAgents, createAgent } from "../api/client";

interface AgentsPageProps {
  onSelectAgent: (name: string) => void;
  onRefresh: () => void;
}

export function AgentsPage({ onSelectAgent, onRefresh }: AgentsPageProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    getAgents().then(setAgents).catch(console.error);
  }, []);

  const filtered = agents.filter((a) =>
    a.name.toLowerCase().includes(search.toLowerCase()) ||
    a.description.toLowerCase().includes(search.toLowerCase()) ||
    a.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))
  );

  const handleCreate = async (name: string, content: string) => {
    try {
      await createAgent(name, content);
      setShowCreate(false);
      getAgents().then(setAgents);
      onRefresh();
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-white">Agents</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{agents.length} agents configured</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          <Plus size={14} /> New Agent
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents..."
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600 placeholder:text-zinc-600"
        />
      </div>

      {/* Agent grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((agent) => (
          <button
            key={agent.name}
            onClick={() => onSelectAgent(agent.name)}
            className="text-left bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">{agent.avatar || "🤖"}</span>
              <span className="font-semibold text-white text-sm">{agent.name}</span>
            </div>
            <p className="text-xs text-zinc-400 mb-2 line-clamp-2">{agent.description}</p>
            <div className="flex flex-wrap gap-1">
              {agent.tags.map((tag) => (
                <span key={tag} className="text-[10px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">{tag}</span>
              ))}
              {agent.skills.length > 0 && (
                <span className="text-[10px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">
                  {agent.skills.length} skills
                </span>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Create dialog */}
      {showCreate && <CreateAgentDialog onClose={() => setShowCreate(false)} onCreate={handleCreate} />}
    </div>
  );
}

function CreateAgentDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, content: string) => void }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState(`---
name: ""
description: ""
model: claude-sonnet-4-6
skills: []
tags: []
---

# Agent Name

## Identity
...

## Responsibilities
...
`);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 w-full max-w-3xl">
        <h2 className="text-sm font-semibold text-white mb-4">Create Agent</h2>
        <div className="mb-3">
          <label className="block text-xs text-zinc-400 mb-1">Name (filename)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            placeholder="my-agent"
            autoFocus
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs text-zinc-400 mb-1">Markdown Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={20}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white cursor-pointer">Cancel</button>
          <button
            onClick={() => name && content && onCreate(name, content)}
            disabled={!name || !content}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg cursor-pointer"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
