import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getBossmodeDir } from "./config.js";
import type { MemberConfig } from "../core/runtime/types.js";

const MEMBERS_PATH = join(getBossmodeDir(), "members.json");

function readAll(): MemberConfig[] {
  if (!existsSync(MEMBERS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(MEMBERS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function writeAll(members: MemberConfig[]): void {
  writeFileSync(MEMBERS_PATH, JSON.stringify(members, null, 2), "utf-8");
}

export function loadMembers(): MemberConfig[] {
  return readAll();
}

export function getMember(id: string): MemberConfig | null {
  return readAll().find((m) => m.id === id) ?? null;
}

export function getMemberByName(name: string): MemberConfig | null {
  return readAll().find((m) => m.name === name) ?? null;
}

export function saveMember(member: Omit<MemberConfig, "id"> & { id?: string }): MemberConfig {
  const members = readAll();
  const config: MemberConfig = {
    ...member,
    id: member.id || randomUUID().slice(0, 8),
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
