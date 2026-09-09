import type { ChildProcess } from "node:child_process";

export interface StartupProgressMessage {
  type: "progress";
  phase: "checking" | "backing-up" | "importing" | "validating" | "cutover" | "retiring" | "starting-services" | "ready";
  completed?: number;
  total?: number;
}
export interface StartupReadyMessage { type: "ready"; host: string; port: number; mode?: "normal" | "recovery"; }
export class StartupWaitError extends Error {
  constructor(message: string, readonly preparationStarted: boolean) { super(message); }
}
const phases = new Set(["checking", "backing-up", "importing", "validating", "cutover", "retiring", "starting-services", "ready"]);

/**
 * Before the first preparation acknowledgement, a missing daemon is a timeout.
 * Once storage preparation starts, inactivity produces a status notice, never a
 * destructive deadline: a large copy/checkpoint may block the child's event loop.
 * The same ordinary command keeps waiting for ready/error/process exit.
 */
export function waitForStartup(child: Pick<ChildProcess, "on" | "off">, options: {
  inactivityMs: number;
  onProgress?(message: StartupProgressMessage): void;
  onStall?(phase: StartupProgressMessage["phase"]): void;
}): Promise<StartupReadyMessage> {
  if (!Number.isFinite(options.inactivityMs) || options.inactivityMs <= 0) throw new Error("Invalid startup inactivity interval");
  return new Promise((resolve, reject) => {
    let phase: StartupProgressMessage["phase"] | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let finished = false;
    const observe = (callback: (() => void) | undefined) => { try { callback?.(); } catch { /* A console observer cannot cancel storage preparation. */ } };
    const cleanup = () => {
      finished = true; clearTimeout(timer);
      child.off("message", onMessage); child.off("exit", onExit); child.off("error", onError);
    };
    const fail = (message: string) => { if (!finished) { cleanup(); reject(new StartupWaitError(message, phase !== undefined)); } };
    const arm = () => {
      if (finished) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!phase) { fail("Daemon did not acknowledge startup preparation before the timeout"); return; }
        const current = phase;
        observe(() => options.onStall?.(current));
        arm();
      }, options.inactivityMs);
    };
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const message = value as Record<string, unknown>;
      if (message.type === "progress" && typeof message.phase === "string" && phases.has(message.phase)) {
        if (message.completed !== undefined && (!Number.isSafeInteger(message.completed) || Number(message.completed) < 0)) return;
        if (message.total !== undefined && (!Number.isSafeInteger(message.total) || Number(message.total) < 0)) return;
        phase = message.phase as StartupProgressMessage["phase"];
        arm(); observe(() => options.onProgress?.(message as unknown as StartupProgressMessage));
      } else if (message.type === "ready") {
        if (typeof message.host !== "string" || !message.host || !Number.isInteger(message.port) || Number(message.port) < 1 || Number(message.port) > 65535 || (message.mode !== undefined && message.mode !== "normal" && message.mode !== "recovery")) {
          fail("Daemon returned an invalid readiness acknowledgement"); return;
        }
        cleanup(); resolve(message as unknown as StartupReadyMessage);
      } else if (message.type === "error" && typeof message.message === "string") fail(message.message);
    };
    const onExit = (code: number | null, signal: string | null) => fail(`Daemon exited before readiness (${signal ?? `code ${code}`})`);
    const onError = (error: Error) => fail(`Daemon process failed: ${error.message}`);
    child.on("message", onMessage); child.on("exit", onExit); child.on("error", onError);
    arm();
  });
}
