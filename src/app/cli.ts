#!/usr/bin/env node
import { getDefaultConfig } from "../config/settings.js";
import { hashPassword } from "../api/auth.js";
import { ensureDirectory } from "../files/io.js";
import { getBossmodeDir } from "../files/layout.js";
import { inspectStartupSettings } from "./upgrade/inventory.js";
import type { BossmodeConfig } from "../config/settings.js";
import { fork, type ChildProcess } from "node:child_process";
import { stopDaemonProcess, processIsAlive } from "./process.js";
import { openSync, closeSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { isProcessRunning, readPidFile, removePidFile } from "./process.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function getLocalIp(): string {
  const nets = networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const info of iface || []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "localhost";
}
function formatAddress(host: string, port: string | number): string {
  if (host === "0.0.0.0") {
    return `http://${getLocalIp()}:${port} (listening on all interfaces)`;
  }
  return `http://${host}:${port}`;
}
async function promptUser(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
async function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf-8");
    let password = "";
    const onData = (ch: string) => {
      const c = ch.toString();
      switch (c) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl+D
          stdin.removeListener("data", onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(password.trim());
          break;
        case "\u0003": // Ctrl+C
          process.exit(1);
          break;
        case "\u007f": // Backspace
          if (password.length > 0) {
            password = password.slice(0, -1);
            process.stdout.write("\b \b");
          }
          break;
        default:
          password += c;
          process.stdout.write("*");
          break;
      }
    };
    stdin.on("data", onData);
  });
}
async function firstRunSetup(): Promise<BossmodeConfig> {
  console.log("Welcome to Bossmode! Let's set up your account.\n");
  const username = await promptUser("Username: ");
  const password = await promptPassword("Password: ");
  if (!username || !password) {
    console.error("Username and password are required.");
    process.exit(1);
  }
  const config = getDefaultConfig();
  config.auth.username = username;
  config.auth.passwordHash = hashPassword(password);
  return config;
}
function parseArgs(args: string[]): { command: string; flags: Record<string, string> } {
  const command = args[0] || "help";
  const flags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : "true";
      flags[key] = value;
    }
  }
  return { command, flags };
}
async function cmdOn(flags: Record<string, string>): Promise<void> {
  ensureDirectory(getBossmodeDir());
  const snapshot = inspectStartupSettings(getBossmodeDir());
  const existingPid = readPidFile();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Bossmode is already running (PID ${existingPid})`);
    if (snapshot.configured) console.log(`Access at ${formatAddress(snapshot.host!, snapshot.port!)}`);
    return;
  }
  if (existingPid) removePidFile();
  const initialConfig = snapshot.configured ? undefined : await firstRunSetup();
  const host = flags.host || snapshot.host || initialConfig!.defaults.host;
  const port = flags.port || String(snapshot.port || initialConfig!.defaults.port);
  if (!/^\d+$/.test(port) || Number(port)<1 || Number(port)>65535) throw new Error("Invalid listen port");

  // Fork daemon process with IPC channel, stdout/stderr → log file
  const serverModule = join(__dirname, "./daemon.js");
  const logPath = join(getBossmodeDir(), "bossmode.log");
  const logFd = openSync(logPath, "a");

  const child = fork(serverModule, [], {
    env: { ...process.env, BOSSMODE_HOST: host, BOSSMODE_PORT: port },
    detached: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
  });

  const address = formatAddress(host, port);

  closeSync(logFd);
  try {
    const waiting = waitForStartup(child, {
      inactivityMs: Math.max(1000, Number(process.env.BOSSMODE_ON_TIMEOUT_MS) || 30000),
      onProgress: progress => { if (progress.completed === undefined) console.log(`Startup: ${progress.phase}`); },
      onStall: phase => console.log(`Startup is still ${phase}; waiting without interrupting storage preparation.`),
    });
    child.send({type:"start",initialConfig});
    await waiting;
    child.disconnect(); child.unref();
    console.log(`Bossmode started at ${address} (PID ${child.pid})`);
    console.log(`Logs: ${logPath}`);
  } catch (err) {
    if (err instanceof StartupWaitError && !err.preparationStarted) { try { child.kill(); } catch {} }
    if (child.connected) child.disconnect(); child.unref();
    console.error(`Failed to start Bossmode: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function cmdOff(): Promise<void> {
  const pid = readPidFile();
  if (!pid) { console.log("Bossmode is not running."); return; }
  if (!processIsAlive(pid)) {
    if (readPidFile() === pid) removePidFile();
    console.log("Bossmode was not running (stale PID file cleaned up).");
    return;
  }
  try {
    await stopDaemonProcess(pid);
    if (readPidFile() === pid) removePidFile();
    console.log(`Bossmode stopped (PID ${pid}).`);
  } catch (error) {
    console.error(`Failed to stop Bossmode: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function cmdStatus(): void {
  const pid = readPidFile();
  if (!pid) {
    console.log("Bossmode is not running.");
    return;
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    console.log("Bossmode is not running (stale PID file cleaned up).");
    return;
  }

  try {
    const config = inspectStartupSettings(getBossmodeDir());
    const host = config.host!;
    const port = config.port!;
    console.log(`Bossmode is running (PID ${pid})`);
    console.log(`Access at ${formatAddress(host, port)}`);
  } catch {
    console.log(`Bossmode is running (PID ${pid})`);
  }
}


function showHelp(): void {
  console.log("Usage: bossmode <on|off|status> [--host <host>] [--port <port>]\nGlobal: --version, -v\nExample: bossmode on --host 0.0.0.0 --port 1234");
}

// -- Main --

async function main(): Promise<void> {
  // --version / -v
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
    console.log(pkg.version);
    process.exit(0);
  }

  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "on":
      await cmdOn(flags);
      break;
    case "off":
      await cmdOff();
      break;
    case "status":
      cmdStatus();
      break;
    case "help":
    default:
      showHelp();
      break;
  }
}


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
export function waitForStartup(child:Pick<ChildProcess,"on"|"off">,options:{inactivityMs:number;onProgress?(message:StartupProgressMessage):void;onStall?(phase:StartupProgressMessage["phase"]):void;}):Promise<StartupReadyMessage>{
  if(!Number.isFinite(options.inactivityMs)||options.inactivityMs<=0)throw new Error("Invalid startup inactivity interval");
  return new Promise((resolve,reject)=>{
    let phase:StartupProgressMessage["phase"]|undefined,timer:ReturnType<typeof setTimeout>,finished=false;
    const cleanup=()=>{finished=true;clearTimeout(timer);child.off("message",onMessage);child.off("exit",onExit);child.off("error",onError);};
    const fail=(message:string)=>{if(!finished){cleanup();reject(new StartupWaitError(message,phase!==undefined));}};
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!phase)return fail("Daemon did not acknowledge startup preparation before the timeout");try{options.onStall?.(phase);}catch{}arm();},options.inactivityMs);};
    const onMessage=(value:unknown)=>{
      if(!value||typeof value!=="object"||Array.isArray(value))return;const message=value as Record<string,unknown>;
      if(message.type==="progress"&&typeof message.phase==="string"&&phases.has(message.phase)){phase=message.phase as StartupProgressMessage["phase"];arm();try{options.onProgress?.(message as unknown as StartupProgressMessage);}catch{}return;}
      if(message.type==="ready"&&typeof message.host==="string"&&Number.isInteger(message.port)){cleanup();resolve(message as unknown as StartupReadyMessage);return;}
      if(message.type==="error"&&typeof message.message==="string")fail(message.message);
    };
    const onExit=(code:number|null,signal:string|null)=>fail(`Daemon exited before readiness (${signal??`code ${code}`})`);
    const onError=(error:Error)=>fail(`Daemon process failed: ${error.message}`);
    child.on("message",onMessage);child.on("exit",onExit);child.on("error",onError);arm();
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
