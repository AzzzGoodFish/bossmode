#!/usr/bin/env node

import { fork } from "node:child_process";
import { openSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import {
  configExists,
  ensureBossmodeDir,
  getBossmodeDir,
  getDefaultConfig,
  hashPassword,
  isProcessRunning,
  readConfig,
  readPidFile,
  removePidFile,
  writeConfig,
} from "../store/config.js";

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

async function firstRunSetup(): Promise<void> {
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

  writeConfig(config);
  console.log("\nConfig saved. You're good to go!\n");
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
  ensureBossmodeDir();

  // First run setup
  if (!configExists()) {
    await firstRunSetup();
  }

  // Check if already running
  const existingPid = readPidFile();
  if (existingPid && isProcessRunning(existingPid)) {
    const config = readConfig();
    const host = config.defaults.host;
    const port = config.defaults.port;
    console.log(`Bossmode is already running (PID ${existingPid})`);
    console.log(`Access at ${formatAddress(host, port)}`);
    return;
  }

  // Clean up stale PID
  if (existingPid) removePidFile();

  const config = readConfig();
  const host = flags.host || config.defaults.host;
  const port = flags.port || String(config.defaults.port);

  // Fork daemon process with IPC channel, stdout/stderr → log file
  const serverModule = join(__dirname, "../server/daemon.js");
  const logPath = join(getBossmodeDir(), "bossmode.log");
  const logFd = openSync(logPath, "a");

  const child = fork(serverModule, [], {
    env: { ...process.env, BOSSMODE_HOST: host, BOSSMODE_PORT: port },
    detached: true,
    stdio: ["ignore", logFd, logFd, "ipc"],
  });

  const address = formatAddress(host, port);

  // Wait for daemon to confirm startup (or fail)
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Daemon startup timed out (5s)"));
      }, 5000);

      child.on("message", (msg: any) => {
        clearTimeout(timeout);
        if (msg.type === "ready") {
          resolve();
        } else if (msg.type === "error") {
          reject(new Error(msg.message));
        }
      });

      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code !== null && code !== 0) {
          reject(new Error(`Daemon exited with code ${code}`));
        }
      });
    });

    // Disconnect IPC so child runs fully detached
    child.disconnect();
    child.unref();

    // Update defaults if flags provided
    if (flags.host || flags.port) {
      config.defaults.host = host;
      config.defaults.port = parseInt(port, 10);
      writeConfig(config);
    }

    console.log(`Bossmode started at ${address} (PID ${child.pid})`);
    console.log(`Logs: ${logPath}`);
  } catch (err: any) {
    // Kill the child if it's still alive
    try { child.kill(); } catch {}
    console.error(`Failed to start Bossmode: ${err.message}`);
    process.exit(1);
  }
}

function cmdOff(): void {
  const pid = readPidFile();
  if (!pid) {
    console.log("Bossmode is not running.");
    return;
  }

  if (!isProcessRunning(pid)) {
    removePidFile();
    console.log("Bossmode was not running (stale PID file cleaned up).");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Bossmode stopped (PID ${pid}).`);
    removePidFile();
  } catch (err: any) {
    console.error(`Failed to stop Bossmode: ${err.message}`);
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
    const config = readConfig();
    const host = config.defaults.host;
    const port = config.defaults.port;
    console.log(`Bossmode is running (PID ${pid})`);
    console.log(`Access at ${formatAddress(host, port)}`);
  } catch {
    console.log(`Bossmode is running (PID ${pid})`);
  }
}

function showHelp(): void {
  console.log(`
Usage: bossmode <command> [options]

Commands:
  on      Start the bossmode server (daemon mode)
  off     Stop the bossmode server
  status  Show server status

Options (for 'on'):
  --host <host>   Bind address (default: 127.0.0.1)
  --port <port>   Port number (default: 8080)

Examples:
  bossmode on
  bossmode on --host 0.0.0.0 --port 1234
  bossmode off
  bossmode status
`);
}

// -- Main --

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "on":
      await cmdOn(flags);
      break;
    case "off":
      cmdOff();
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

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
