// Structured logger — console.log lines picked up by daemon log file
type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const line = data
    ? `[${ts}] ${level.toUpperCase()} [${category}] ${message} ${JSON.stringify(data)}`
    : `[${ts}] ${level.toUpperCase()} [${category}] ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

// Format spawn args for readable multi-line output
// Long values (--system-prompt, --append-system-prompt) are replaced with <N chars>
const REDACT_FLAGS = new Set(["--system-prompt", "--append-system-prompt"]);

export function formatSpawnArgs(command: string, args: string[]): string {
  const lines: string[] = [`  command: ${command}`];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      const value = args[i + 1];
      const display = REDACT_FLAGS.has(arg) ? `<${value.length} chars>` : value;
      lines.push(`    ${arg} ${display}`);
      i++; // skip value
    } else {
      lines.push(`    ${arg}`);
    }
  }
  return lines.join("\n");
}

export const logger = {
  info: (cat: string, msg: string, data?: Record<string, unknown>) => log("info", cat, msg, data),
  warn: (cat: string, msg: string, data?: Record<string, unknown>) => log("warn", cat, msg, data),
  error: (cat: string, msg: string, data?: Record<string, unknown>) => log("error", cat, msg, data),
};
