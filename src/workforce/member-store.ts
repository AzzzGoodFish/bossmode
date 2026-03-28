import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "../shared/config.js";
import type { AgentMemberConfig, MemberConfig, LegacyMemberConfig } from "../shared/types.js";

const MEMBERS_PATH = join(getBossmodeDir(), "members.json");

// Backward compat: old members.json entries lack type field
function normalizeMember(raw: LegacyMemberConfig | AgentMemberConfig): AgentMemberConfig {
  return {
    id: raw.id,
    name: raw.name,
    type: "agent",
    agent: raw.agent,
    model: raw.model,
    runtime: raw.runtime,
    thinkingLevel: raw.thinkingLevel,
    avatar: raw.avatar,
    contextLimit: raw.contextLimit,
    skills: raw.skills,
  };
}

function readAll(): AgentMemberConfig[] {
  if (!existsSync(MEMBERS_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(MEMBERS_PATH, "utf-8")) as (LegacyMemberConfig | AgentMemberConfig)[];
    return raw.map(normalizeMember);
  } catch {
    return [];
  }
}

function writeAll(members: AgentMemberConfig[]): void {
  writeFileSync(MEMBERS_PATH, JSON.stringify(members, null, 2), "utf-8");
}

export function loadMembers(): AgentMemberConfig[] {
  return readAll();
}

export function getMember(id: string): AgentMemberConfig | null {
  return readAll().find((m) => m.id === id) ?? null;
}

export function getMemberByName(name: string): AgentMemberConfig | null {
  return readAll().find((m) => m.name === name) ?? null;
}

export function saveMember(member: Omit<AgentMemberConfig, "id" | "type"> & { id?: string }): AgentMemberConfig {
  const members = readAll();
  const config: AgentMemberConfig = {
    ...member,
    id: member.id || randomUUID().slice(0, 8),
    type: "agent",
  };

  const idx = members.findIndex((m) => m.id === config.id);
  if (idx !== -1) {
    members[idx] = config;
  } else {
    members.push(config);
  }

  writeAll(members);
  return config;
}

export function deleteMember(id: string): boolean {
  const members = readAll();
  const filtered = members.filter((m) => m.id !== id);
  if (filtered.length === members.length) return false;
  writeAll(filtered);
  return true;
}
