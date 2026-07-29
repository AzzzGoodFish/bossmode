// Watch subscriptions — file-backed ledger (watches.json per room, aligned with cursors.json).
// v1: leader-only · watch member (one-shot) · 7-day TTL lazy sweep.
// A subscription consumes itself on first trigger ("先销后激活") — no retry storm.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { roomDir } from "./room-store.js";

export interface WatchRecord {
  id: string;
  watcherMemberId: string;
  targetMemberId: string;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 7 * 24 * 60 * 60_000;

function watchesPath(roomId: string): string {
  return join(roomDir(roomId), "watches.json");
}

function readRaw(roomId: string): WatchRecord[] {
  const path = watchesPath(roomId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(roomId: string, watches: WatchRecord[]): void {
  writeFileSync(watchesPath(roomId), JSON.stringify(watches, null, 2), "utf-8");
}

/** Drop expired records (lazy TTL sweep, on any read/mutation). Returns live records. */
function sweep(roomId: string): WatchRecord[] {
  const now = Date.now();
  const all = readRaw(roomId);
  const live = all.filter((w) => w.expiresAt > now);
  if (live.length !== all.length) writeRaw(roomId, live);
  return live;
}

/**
 * Drop expired records and RETURN the dropped ones, so callers can post a
 * room-visible expiry note. Pure storage: no message posting here — callers
 * (watch tool actions, watch trigger) own notification.
 */
export function sweepExpired(roomId: string): WatchRecord[] {
  const now = Date.now();
  const all = readRaw(roomId);
  const dropped = all.filter((w) => w.expiresAt <= now);
  if (dropped.length === 0) return [];
  writeRaw(roomId, all.filter((w) => w.expiresAt > now));
  return dropped;
}

/** One live watch per (watcher, target); re-subscribe replaces. Returns the stored record. */
export function addWatch(roomId: string, watcherMemberId: string, targetMemberId: string): WatchRecord {
  const live = sweep(roomId).filter((w) => !(w.watcherMemberId === watcherMemberId && w.targetMemberId === targetMemberId));
  const now = Date.now();
  const record: WatchRecord = {
    id: `watch-${randomUUID().slice(0, 8)}`,
    watcherMemberId,
    targetMemberId,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  live.push(record);
  writeRaw(roomId, live);
  return record;
}

export function removeWatch(roomId: string, watcherMemberId: string, targetMemberId: string): boolean {
  const live = sweep(roomId);
  const next = live.filter((w) => !(w.watcherMemberId === watcherMemberId && w.targetMemberId === targetMemberId));
  if (next.length === live.length) return false;
  writeRaw(roomId, next);
  return true;
}

/** Consume a watch (delete before activation — one-shot). No-op if absent. */
export function consumeWatch(roomId: string, watchId: string): void {
  const live = readRaw(roomId).filter((w) => w.id !== watchId);
  writeRaw(roomId, live);
}

export function listWatches(roomId: string, watcherMemberId?: string): WatchRecord[] {
  const live = sweep(roomId);
  return watcherMemberId ? live.filter((w) => w.watcherMemberId === watcherMemberId) : live;
}

/** Live watches whose target posted (used by the message-bus trigger). */
export function findWatchesForTarget(roomId: string, targetMemberId: string): WatchRecord[] {
  return sweep(roomId).filter((w) => w.targetMemberId === targetMemberId);
}
