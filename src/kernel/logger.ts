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

export const logger = {
  info: (cat: string, msg: string, data?: Record<string, unknown>) => log("info", cat, msg, data),
  warn: (cat: string, msg: string, data?: Record<string, unknown>) => log("warn", cat, msg, data),
  error: (cat: string, msg: string, data?: Record<string, unknown>) => log("error", cat, msg, data),
};
