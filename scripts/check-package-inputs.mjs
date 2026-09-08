#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] || process.cwd());
const required = [
  "vendor/pi-mcp-adapter/index.ts",
  "vendor/pi-mcp-adapter/LICENSE",
];
const missing = required.filter((path) => {
  const absolute = resolve(root, path);
  return !existsSync(absolute) || !statSync(absolute).isFile();
});

if (missing.length > 0) {
  console.error(`Package input missing: ${missing.join(", ")}`);
  console.error("Initialize the pinned adapter first: git submodule update --init vendor/pi-mcp-adapter");
  process.exit(1);
}
