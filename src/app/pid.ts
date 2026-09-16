// Daemon PID file — app entry concern (moved out of config in P9).
// Path semantics unchanged: <BOSSMODE_DIR>/bossmode.pid.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureBossmodeDir, getBossmodeDir } from "../config/config.js";

const PID_PATH = join(getBossmodeDir(), "bossmode.pid");

export function writePidFile(pid: number): void {
  ensureBossmodeDir();
  writeFileSync(PID_PATH, String(pid), "utf-8");
}

export function readPidFile(): number | null {
  try {
    const raw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // ignore
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
