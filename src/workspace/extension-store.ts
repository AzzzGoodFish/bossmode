// Bossmode self-managed extensions — aligned with pi CLI package model.
//
// Layout (mirrors ~/.pi/agent/npm):
//   ~/.bossmode/extensions/package.json       private npm project
//   ~/.bossmode/extensions/package-lock.json
//   ~/.bossmode/extensions/node_modules/
//   ~/.bossmode/extensions.json               { packages: ["npm:pi-web-access", ...] }
//
// Install = record package id + npm install into extensions/
// Uninstall = reverse
// Load = read each package.json "pi.extensions" / "pi.skills" entry arrays
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { getBossmodeDir, ensureBossmodeDir } from "../shared/config.js";
import { logger } from "../foundation/logger.js";

export interface ExtensionRecord {
  /** Canonical id as stored, e.g. "npm:pi-web-access" */
  id: string;
  /** npm package name without scheme */
  name: string;
  version?: string;
  /** Absolute paths to extension entry files (from package.json pi.extensions) */
  extensionPaths: string[];
  /** Absolute skill directories (from package.json pi.skills) */
  skillPaths: string[];
  /** package.json description if present */
  description?: string;
  error?: string;
}

interface ExtensionsManifest {
  packages: string[];
}

const MANIFEST_FILE = "extensions.json";

function extensionsProjectDir(): string {
  return join(getBossmodeDir(), "extensions");
}

function manifestPath(): string {
  return join(getBossmodeDir(), MANIFEST_FILE);
}

/** Map user-facing source (pi install style) to npm install arg + manifest id. */
function normalizePackageId(input: string): { id: string; name: string; npmArg: string } {
  const raw = input.trim();
  if (!raw) throw new Error("Package name is required");

  // npm:@scope/pkg or npm:pkg
  if (raw.startsWith("npm:")) {
    const name = raw.slice("npm:".length).trim();
    if (!name) throw new Error("Invalid npm package id");
    return { id: `npm:${name}`, name, npmArg: name };
  }

  // git:github.com/user/repo  or git:git@github.com:user/repo
  if (raw.startsWith("git:")) {
    const rest = raw.slice("git:".length).trim();
    if (!rest) throw new Error("Invalid git source");
    let npmArg: string;
    if (rest.startsWith("git@") || rest.startsWith("ssh://")) {
      npmArg = rest.startsWith("git+") ? rest : `git+${rest}`;
    } else if (rest.startsWith("http://") || rest.startsWith("https://")) {
      npmArg = rest.startsWith("git+") ? rest : `git+${rest}`;
    } else {
      // host/user/repo (e.g. github.com/user/repo)
      npmArg = `git+https://${rest}`;
    }
    const leaf = rest.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/, "") || rest;
    return { id: raw, name: leaf, npmArg };
  }

  // https:// or ssh:// URL
  if (/^https?:\/\//i.test(raw) || /^ssh:\/\//i.test(raw)) {
    const leaf = raw.split("/").filter(Boolean).pop()?.replace(/\.git$/, "") || "package";
    const npmArg = raw.startsWith("git+") ? raw : (/^https?:\/\//i.test(raw) ? raw : `git+${raw}`);
    return { id: raw, name: leaf, npmArg };
  }

  // local path
  if (raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("/")) {
    const leaf = raw.split("/").filter(Boolean).pop() || "local-package";
    return { id: `path:${raw}`, name: leaf, npmArg: raw };
  }

  // bare name → npm scheme (pi CLI convention)
  return { id: `npm:${raw}`, name: raw, npmArg: raw };
}

function readManifest(): ExtensionsManifest {
  try {
    if (!existsSync(manifestPath())) return { packages: [] };
    const parsed = JSON.parse(readFileSync(manifestPath(), "utf-8")) as Partial<ExtensionsManifest>;
    return { packages: Array.isArray(parsed.packages) ? parsed.packages.map(String) : [] };
  } catch {
    return { packages: [] };
  }
}

function writeManifest(manifest: ExtensionsManifest): void {
  ensureBossmodeDir();
  writeFileSync(manifestPath(), JSON.stringify({ packages: manifest.packages, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
}

function ensureExtensionsProject(): void {
  const dir = extensionsProjectDir();
  mkdirSync(dir, { recursive: true });
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({
      name: "bossmode-extensions",
      private: true,
      description: "Bossmode-managed pi agent extensions",
      dependencies: {},
    }, null, 2), "utf-8");
  }
}

function packageRoot(name: string): string {
  // Prefer direct node_modules/<name>; fall back to nested (scoped packages)
  const direct = join(extensionsProjectDir(), "node_modules", name);
  if (existsSync(join(direct, "package.json"))) return direct;
  // scoped: @scope/pkg
  if (name.startsWith("@")) {
    const scoped = join(extensionsProjectDir(), "node_modules", name);
    if (existsSync(join(scoped, "package.json"))) return scoped;
  }
  return direct;
}

function inspectPackage(name: string): Omit<ExtensionRecord, "id"> {
  const root = packageRoot(name);
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    return { name, extensionPaths: [], skillPaths: [], error: "Package not found on disk" };
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      version?: string;
      description?: string;
      pi?: { extensions?: string[]; skills?: string[] };
    };
    const extEntries = Array.isArray(pkg.pi?.extensions) ? pkg.pi!.extensions! : [];
    const skillEntries = Array.isArray(pkg.pi?.skills) ? pkg.pi!.skills! : [];
    const extensionPaths = extEntries
      .map((e) => resolve(root, e))
      .filter((p) => existsSync(p));
    const skillPaths = skillEntries
      .map((e) => resolve(root, e))
      .filter((p) => existsSync(p));
    return {
      name: pkg.name || name,
      version: pkg.version,
      description: pkg.description,
      extensionPaths,
      skillPaths,
      error: extEntries.length > 0 && extensionPaths.length === 0
        ? "pi.extensions entries missing on disk"
        : undefined,
    };
  } catch (err) {
    return { name, extensionPaths: [], skillPaths: [], error: String(err) };
  }
}

export function listInstalledExtensions(): ExtensionRecord[] {
  const manifest = readManifest();
  return manifest.packages.map((id) => {
    const { name } = normalizePackageId(id);
    return { id, ...inspectPackage(name) };
  });
}

/** Absolute extension entry paths for all installed packages (for session injection). */
export function resolveInstalledExtensionPaths(): string[] {
  return collectPaths(listInstalledExtensions(), "extensionPaths");
}

/** Absolute skill dirs declared by installed packages. */
export function resolveInstalledExtensionSkillPaths(): string[] {
  return collectPaths(listInstalledExtensions(), "skillPaths");
}

function extensionMatchesEnabled(ext: ExtensionRecord, enabled: Set<string>): boolean {
  const keys = [ext.id, ext.name, ext.id.replace(/^npm:/, ""), `npm:${ext.name}`];
  return keys.some((k) => enabled.has(k));
}

function collectPaths(exts: ExtensionRecord[], field: "extensionPaths" | "skillPaths"): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const ext of exts) {
    for (const p of ext[field]) {
      if (!seen.has(p)) {
        seen.add(p);
        paths.push(p);
      }
    }
  }
  return paths;
}

/**
 * Paths for extensions explicitly enabled on a member (`config.extensions`).
 * Default empty list = load nothing. Unknown/uninstalled ids are skipped silently.
 */
export function resolveMemberExtensionPaths(enabledIds: string[] | undefined | null): string[] {
  if (!enabledIds?.length) return [];
  const enabled = new Set(enabledIds.map((s) => s.trim()).filter(Boolean));
  const matched = listInstalledExtensions().filter((ext) => extensionMatchesEnabled(ext, enabled));
  return collectPaths(matched, "extensionPaths");
}

export function resolveMemberExtensionSkillPaths(enabledIds: string[] | undefined | null): string[] {
  if (!enabledIds?.length) return [];
  const enabled = new Set(enabledIds.map((s) => s.trim()).filter(Boolean));
  const matched = listInstalledExtensions().filter((ext) => extensionMatchesEnabled(ext, enabled));
  return collectPaths(matched, "skillPaths");
}

export function installExtension(packageSpec: string): ExtensionRecord {
  const { id, name, npmArg } = normalizePackageId(packageSpec);
  ensureBossmodeDir();
  ensureExtensionsProject();
  const dir = extensionsProjectDir();

  logger.info("extensions", "install start", { id, name, npmArg, dir });
  try {
    execFileSync("npm", ["install", npmArg, "--save", "--no-fund", "--no-audit"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, npm_config_update_notifier: "false" },
      timeout: 180_000,
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() || err?.message || String(err);
    logger.error("extensions", "npm install failed", { id, error: stderr.slice(0, 500) });
    throw new Error(`Failed to install ${name}: ${stderr.slice(0, 300)}`);
  }

  // Resolve actual package name from node_modules after install (git URLs rename).
  let resolvedName = name;
  const nm = join(dir, "node_modules");
  if (!existsSync(join(nm, resolvedName, "package.json")) && existsSync(nm)) {
    // Find newest package with pi.extensions
    try {
      for (const entry of readdirSync(nm, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) {
          for (const scoped of readdirSync(join(nm, entry.name), { withFileTypes: true })) {
            if (!scoped.isDirectory()) continue;
            const full = `${entry.name}/${scoped.name}`;
            const insp = inspectPackage(full);
            if (insp.extensionPaths.length > 0) resolvedName = full;
          }
        } else {
          const insp = inspectPackage(entry.name);
          if (insp.extensionPaths.length > 0 && !readManifest().packages.some((p) => normalizePackageId(p).name === entry.name)) {
            resolvedName = entry.name;
          }
        }
      }
    } catch { /* keep name */ }
  }

  const inspected = inspectPackage(resolvedName);
  if (inspected.error && inspected.extensionPaths.length === 0) {
    throw new Error(`Installed ${resolvedName} but it is not a pi extension (missing pi.extensions): ${inspected.error}`);
  }

  const manifestId = id.startsWith("npm:") ? `npm:${resolvedName}` : id;
  const manifest = readManifest();
  if (!manifest.packages.includes(manifestId)) {
    manifest.packages = [...manifest.packages, manifestId].sort();
    writeManifest(manifest);
  }
  logger.info("extensions", "install ok", { id: manifestId, version: inspected.version, extensions: inspected.extensionPaths.length });
  return { id: manifestId, ...inspected };
}

export function uninstallExtension(packageSpec: string): { ok: true; id: string } {
  const { id, name } = normalizePackageId(packageSpec);
  ensureExtensionsProject();
  const dir = extensionsProjectDir();
  const manifest = readManifest();

  if (existsSync(join(dir, "node_modules", name)) || existsSync(packageRoot(name))) {
    try {
      execFileSync("npm", ["uninstall", name, "--save", "--no-fund", "--no-audit"], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, npm_config_update_notifier: "false" },
        timeout: 120_000,
      });
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() || err?.message || String(err);
      logger.warn("extensions", "npm uninstall warning", { id, error: stderr.slice(0, 300) });
      // Still remove from manifest; force-rm node_modules entry
      try {
        const root = packageRoot(name);
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  manifest.packages = manifest.packages.filter((p) => p !== id && normalizePackageId(p).name !== name);
  writeManifest(manifest);
  logger.info("extensions", "uninstall ok", { id });
  return { ok: true, id };
}

/** Path hint for web-search config (shared with pi CLI). */
export function webSearchConfigPath(): string {
  return join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "web-search.json");
}

export function webSearchConfigExists(): boolean {
  try {
    return existsSync(webSearchConfigPath());
  } catch {
    return false;
  }
}
