// Gate store — per-room artifact gates (stage approval checkpoints), backed by rooms/<id>/gates.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir } from "./room-store.js";
import type { Gate, GateStatus } from "../shared/types.js";

function gatesPath(roomId: string): string {
  return join(roomDir(roomId), "gates.json");
}

function normalizeGate(raw: any): Gate {
  return {
    id: String(raw?.id || `gate-${randomUUID().slice(0, 8)}`),
    roomId: String(raw?.roomId || ""),
    title: String(raw?.title || "Untitled"),
    summary: String(raw?.summary || ""),
    artifacts: Array.isArray(raw?.artifacts) ? raw.artifacts.map(String).filter(Boolean) : [],
    requestedBy: String(raw?.requestedBy || "unknown"),
    handoffTo: raw?.handoffTo ? String(raw.handoffTo) : undefined,
    status: (["pending", "approved", "rejected"].includes(raw?.status) ? raw.status : "pending") as GateStatus,
    decisionNote: raw?.decisionNote ? String(raw.decisionNote) : undefined,
    createdAt: Number(raw?.createdAt) || Date.now(),
    decidedAt: raw?.decidedAt ? Number(raw.decidedAt) : undefined,
  };
}

function readGates(roomId: string): Gate[] {
  const p = gatesPath(roomId);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(parsed) ? parsed.map(normalizeGate) : [];
  } catch {
    return [];
  }
}

function writeGates(roomId: string, gates: Gate[]): void {
  writeFileSync(gatesPath(roomId), JSON.stringify(gates, null, 2));
}

export function createGate(
  roomId: string,
  data: { title: string; summary: string; artifacts?: string[]; requestedBy: string; handoffTo?: string },
): Gate {
  const gate: Gate = {
    id: `gate-${randomUUID().slice(0, 8)}`,
    roomId,
    title: data.title.trim() || "Untitled",
    summary: data.summary.trim(),
    artifacts: (data.artifacts || []).map((a) => String(a).trim()).filter(Boolean),
    requestedBy: data.requestedBy,
    handoffTo: data.handoffTo?.trim() || undefined,
    status: "pending",
    createdAt: Date.now(),
  };
  const gates = readGates(roomId);
  gates.push(gate);
  writeGates(roomId, gates);
  return gate;
}

export function getGate(roomId: string, gateId: string): Gate | null {
  return readGates(roomId).find((g) => g.id === gateId) || null;
}

export function listGates(roomId: string, opts?: { status?: GateStatus }): Gate[] {
  let gates = readGates(roomId);
  if (opts?.status) gates = gates.filter((g) => g.status === opts.status);
  return gates.sort((a, b) => b.createdAt - a.createdAt);
}

/** Decide a pending gate. Returns null if not found; throws if already decided. */
export function decideGate(
  roomId: string,
  gateId: string,
  action: "approve" | "reject",
  decisionNote?: string,
): Gate | null {
  const gates = readGates(roomId);
  const gate = gates.find((g) => g.id === gateId);
  if (!gate) return null;
  if (gate.status !== "pending") {
    throw new Error(`Gate already ${gate.status}`);
  }
  gate.status = action === "approve" ? "approved" : "rejected";
  gate.decisionNote = decisionNote?.trim() || undefined;
  gate.decidedAt = Date.now();
  writeGates(roomId, gates);
  return gate;
}
