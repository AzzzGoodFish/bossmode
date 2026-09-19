// Daemon PID file — app entry concern (moved out of config in P9).
// Path semantics unchanged: <BOSSMODE_DIR>/bossmode.pid.
import { ensureDirectory } from "../files/io.js";
import { getBossmodeDir } from "../files/layout.js";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const PID_PATH = join(getBossmodeDir(), "bossmode.pid");
export function writePidFile(pid: number): void {
  ensureDirectory(getBossmodeDir());
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
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // A permission failure is not evidence that the process stopped.
    throw error;
  }
}
/** Keep PID ownership until the old writer has actually exited. Never SIGKILL. */
export async function stopDaemonProcess(pid: number, timeoutMs = 30000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid === process.pid) throw new Error("Invalid daemon process identity");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid shutdown timeout");
  if (!processIsAlive(pid)) return;
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("Daemon is still stopping; its PID ownership was retained");
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
}
