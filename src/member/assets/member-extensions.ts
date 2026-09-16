import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memberExtensionsDir } from "../../files/layout.js";

/** Filesystem discovery only: entries are not evidence of successful execution. */
export interface ExtensionAsset {
  name: string;
  path: string;
  realPath: string | null;
  entryPoints: string[];
  source: "member" | "builtin";
  issues: string[];
}

const INSTALL_ARTIFACTS = new Set(["node_modules", "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);

export function builtinMcpAdapterPath(): string {
  return fileURLToPath(new URL("../../../vendor/pi-mcp-adapter/index.ts", import.meta.url));
}

function assetAt(path: string, source: ExtensionAsset["source"]): ExtensionAsset {
  const asset: ExtensionAsset = { name: basename(path), path, realPath: null, entryPoints: [], source, issues: [] };
  try { asset.realPath = realpathSync(path); }
  catch { asset.issues.push("Path is missing or inaccessible (possibly a broken symbolic link)."); }
  return asset;
}

function pathPresent(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (err: any) { return err.code !== "ENOENT"; }
}

function addEntry(asset: ExtensionAsset, path: string): void {
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    if (!asset.entryPoints.includes(path)) asset.entryPoints.push(path);
  } catch {
    asset.issues.push(`Extension entry is missing, inaccessible, or not a file: ${path}`);
  }
}

/** Same discovery is used by Assets, session creation, and reload. Never import modules here. */
export function discoverMemberExtensions(extDir: string): ExtensionAsset[] {
  let entries;
  try { entries = readdirSync(extDir, { withFileTypes: true }); }
  catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const assets: ExtensionAsset[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || INSTALL_ARTIFACTS.has(entry.name)) continue;
    const path = resolve(extDir, entry.name);
    if (!(entry.isDirectory() || entry.isSymbolicLink() || (entry.isFile() && /\.(ts|js)$/.test(entry.name)))) continue;
    const asset = assetAt(path, "member");
    if (!asset.realPath) { assets.push(asset); continue; }
    let directory: boolean;
    try { directory = statSync(path).isDirectory(); }
    catch { asset.issues.push("Cannot inspect extension path."); assets.push(asset); continue; }
    if (!directory) {
      if (/\.(ts|js)$/.test(entry.name)) { addEntry(asset, path); assets.push(asset); }
      continue;
    }
    const manifest = join(path, "package.json");
    if (pathPresent(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof pkg?.name === "string" && pkg.name.trim()) asset.name = pkg.name.trim();
        const declared = pkg?.pi?.extensions;
        if (declared !== undefined) {
          if (!Array.isArray(declared) || declared.some((p) => typeof p !== "string" || !p.trim())) {
            asset.issues.push("package.json pi.extensions must be an array of non-empty paths.");
          } else {
            for (const rel of declared) addEntry(asset, join(path, rel));
          }
          // An explicit manifest is authoritative, including an empty list.
          if (asset.entryPoints.length || asset.issues.length) assets.push(asset);
          continue;
        }
      } catch {
        asset.issues.push("Cannot read or parse package.json.");
        assets.push(asset);
        continue;
      }
    }
    const index = ["index.ts", "index.js"].find((file) => pathPresent(join(path, file)));
    if (index) { addEntry(asset, join(path, index)); assets.push(asset); }
  }
  return assets;
}

export function extensionEntryPoints(assets: ExtensionAsset[]): string[] {
  const seen = new Set<string>();
  return assets.flatMap((asset) => asset.entryPoints).filter((path) => {
    // Keep the configured path for loader diagnostics; deduplicate aliases by target.
    const target = realpathSync(path);
    if (seen.has(target)) return false;
    seen.add(target);
    return true;
  });
}

export function discoverMemberExtensionEntries(extDir: string): string[] {
  return extensionEntryPoints(discoverMemberExtensions(extDir));
}

export function listMemberExtensions(memberId: string): ExtensionAsset[] {
  const builtin = assetAt(builtinMcpAdapterPath(), "builtin");
  builtin.name = "pi-mcp-adapter";
  if (builtin.realPath) addEntry(builtin, builtin.path);
  return [...discoverMemberExtensions(memberExtensionsDir(memberId)), builtin];
}
