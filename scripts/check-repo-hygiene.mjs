import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const violations = [];
const forbiddenPaths = [
  /(^|\/)\.bossmode-attachments\//,
  /(^|\/)\.bossmode-prototypes\//,
  /(^|\/)\.playwright-mcp\//,
  /^docs\/bossmode\//,
  /^design-prototype\//,
  /(^|\/)(node_modules|dist|coverage|archive|memory)\//,
  /(^|\/)(team-mock|library-mock|room-member-management-mock)\.[cm]?[jt]sx?$/,
];
const forbiddenNames = [
  /^\.env(?:\.|$)/,
  /\.(?:pem|p12|pfx|key|tgz|log|jsonl|sqlite|sqlite3|db)$/i,
  /^(?:credentials?|secrets?)\.json$/i,
  /^(?:\.DS_Store|Thumbs\.db)$/,
];
const textExtensions = /\.(?:[cm]?[jt]sx?|json|md|html|css|ya?ml|toml|txt|sh)$/i;
const privatePath = /(?:^|[^\w])(?:\/home\/[^/\s]+|\/Users\/[^/\s]+)/;
const lanAddress = /\b(?:192\.168\.|10\.(?:\d{1,3}\.){2}|172\.(?:1[6-9]|2\d|3[01])\.)\d{1,3}\b/;

for (const path of tracked) {
  if (forbiddenPaths.some((pattern) => pattern.test(path))) violations.push(`${path}: forbidden repository path`);
  if (forbiddenNames.some((pattern) => pattern.test(basename(path)))) violations.push(`${path}: forbidden local or sensitive filename`);
  const stat = statSync(path);
  if (stat.size > 2 * 1024 * 1024) violations.push(`${path}: tracked file exceeds 2 MiB`);
  if (textExtensions.test(path) && stat.size <= 2 * 1024 * 1024) {
    const content = readFileSync(path, "utf8");
    if (privatePath.test(content)) violations.push(`${path}: contains an absolute user-home path`);
    if (lanAddress.test(content)) violations.push(`${path}: contains a private-network address`);
  }
}

if (violations.length) {
  console.error("Repository hygiene check failed:\n" + violations.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`Repository hygiene check passed (${tracked.length} tracked files).`);
