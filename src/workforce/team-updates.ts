import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  type Dirent,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { logger } from "../foundation/logger.js";

interface TeamMetaFile {
  installedVersion: string;
  dismissedVersion: string | null;
  dismissPermanent: boolean;
  files: Record<string, FileRecord>;
}

interface FileRecord {
  hash: string;
  version: string;
}

type AssetCategory = "agent" | "skill" | "rule";

type UpdateStatus = "new" | "updated" | "modified";

export interface UpdateCandidate {
  category: AssetCategory;
  relativePath: string;
  name: string;
  status: UpdateStatus;
  templateHash: string;
  localHash: string | null;
  installedHash: string | null;
}

export interface UpdateCheckResult {
  hasUpdates: boolean;
  currentVersion: string;
  installedVersion: string;
  candidates: UpdateCandidate[];
  dismissed: boolean;
}

const META_FILENAME = "team-meta.json";

interface TemplateFile {
  category: AssetCategory;
  relativePath: string;
  name: string;
  templateContent: string;
  localPath: string;
}

function bossmodeDir(): string {
  return process.env.BOSSMODE_DIR || join(homedir(), ".bossmode");
}

function metaPath(): string {
  return join(bossmodeDir(), META_FILENAME);
}

function defaultMeta(): TeamMetaFile {
  return {
    installedVersion: "0.0.0",
    dismissedVersion: null,
    dismissPermanent: false,
    files: {},
  };
}

function readMeta(): TeamMetaFile {
  try {
    if (!existsSync(metaPath())) return defaultMeta();
    const parsed = JSON.parse(readFileSync(metaPath(), "utf-8")) as Partial<TeamMetaFile>;
    return {
      installedVersion: parsed.installedVersion || "0.0.0",
      dismissedVersion: parsed.dismissedVersion ?? null,
      dismissPermanent: parsed.dismissPermanent === true,
      files: parsed.files || {},
    };
  } catch (err) {
    logger.error("team-updates", "failed to read team-meta.json; using default", { error: String(err) });
    return defaultMeta();
  }
}

function writeMeta(meta: TeamMetaFile): void {
  mkdirSync(bossmodeDir(), { recursive: true });
  writeFileSync(metaPath(), JSON.stringify(meta, null, 2), "utf-8");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function parseVersion(v: string): number[] {
  return v.split(".").map((x) => Number(x) || 0);
}

function isVersionLess(a: string, b: string): boolean {
  const aa = parseVersion(a);
  const bb = parseVersion(b);
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    const av = aa[i] || 0;
    const bv = bb[i] || 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

function getCurrentVersion(): string {
  const candidates = [
    join(process.cwd(), "package.json"),
    join(process.cwd(), "..", "package.json"),
  ];
  try {
    const here = new URL(".", import.meta.url).pathname;
    candidates.push(join(here, "..", "..", "package.json"));
    candidates.push(join(here, "..", "..", "..", "package.json"));
  } catch { /* ignore */ }

  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      const pkg = JSON.parse(readFileSync(c, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* ignore */ }
  }
  return "0.0.0";
}

function findTemplatesDir(): string | null {
  const candidates = [
    join(process.cwd(), "templates"),
    join(process.cwd(), "..", "templates"),
  ];
  try {
    const here = new URL(".", import.meta.url).pathname;
    candidates.push(join(here, "..", "..", "templates"));
    candidates.push(join(here, "..", "..", "..", "templates"));
  } catch { /* ignore */ }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export function toRulePath(relTemplatePath: string): string {
  const rel = relTemplatePath.replace(/\\/g, "/");
  if (rel === "dev-team/team-prompt.md") return "rules/dev-team-protocol.md";
  if (rel.endsWith("/team-prompt.md")) {
    const parts = rel.split("/");
    const teamName = parts[parts.length - 2];
    return `rules/${teamName}-protocol.md`;
  }
  const fileName = rel.split("/").pop()!;
  return `rules/${fileName}`;
}

function enumerateTemplates(): TemplateFile[] {
  const templatesDir = findTemplatesDir();
  if (!templatesDir) return [];
  const out: TemplateFile[] = [];

  const agentsDir = join(templatesDir, "agents");
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
      out.push({
        category: "agent",
        relativePath: `agents/${f}`,
        name: f.replace(/\.md$/i, ""),
        templateContent: readFileSync(join(agentsDir, f), "utf-8"),
        localPath: join(bossmodeDir(), "agents", f),
      });
    }
  }

  const skillsDir = join(templatesDir, "skills");
  if (existsSync(skillsDir)) {
    for (const d of readdirSync(skillsDir)) {
      const skillPath = join(skillsDir, d, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      out.push({
        category: "skill",
        relativePath: `skills/${d}/SKILL.md`,
        name: d,
        templateContent: readFileSync(skillPath, "utf-8"),
        localPath: join(bossmodeDir(), "skills", d, "SKILL.md"),
      });
    }
  }

  const teamsDir = join(templatesDir, "teams");
  if (existsSync(teamsDir)) {
    const walk = (dir: string, relDir = ""): void => {
      let entries: Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]; }
      catch { return; }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = join(dir, e.name);
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          walk(abs, rel);
          continue;
        }
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
        const rulePath = toRulePath(rel);
        out.push({
          category: "rule",
          relativePath: rulePath,
          name: basename(rulePath, ".md"),
          templateContent: readFileSync(abs, "utf-8"),
          localPath: join(bossmodeDir(), "knowledge", "docs", ...rulePath.split("/")),
        });
      }
    };
    walk(teamsDir);
  }

  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

function parseYamlFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  return { meta: (parseYaml(m[1]) || {}) as Record<string, unknown>, body: m[2].trimStart() };
}

function serializeFrontmatter(meta: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(meta).trim()}\n---\n\n${body.trimStart()}`;
}

function injectBuiltinFrontmatter(content: string, version: string): string {
  const { meta, body } = parseYamlFrontmatter(content);
  const nextMeta: Record<string, unknown> = { ...meta, source: "builtin", version };
  return serializeFrontmatter(nextMeta, body);
}

function parseRuleTemplate(content: string, rulePath: string): { title: string; body: string } {
  let body = content;
  const h1 = body.match(/^#\s+(.+)\n/);
  let title = basename(rulePath, ".md").replace(/[-_]/g, " ");
  if (h1) {
    title = h1[1].trim();
    body = body.slice(h1[0].length).trimStart();
  }
  return { title, body };
}

function buildRuleDoc(title: string, body: string, version: string): string {
  const now = Date.now();
  const meta: Record<string, unknown> = {
    title,
    type: "rule",
    source: "builtin",
    version,
    author: "builtin",
    created: now,
    updated: now,
  };
  return serializeFrontmatter(meta, body);
}

function getLocalContent(tpl: TemplateFile): string | null {
  try {
    if (tpl.category === "rule") {
      if (!existsSync(tpl.localPath)) return null;
      return readFileSync(tpl.localPath, "utf-8");
    }
    if (!existsSync(tpl.localPath)) return null;
    return readFileSync(tpl.localPath, "utf-8");
  } catch {
    return null;
  }
}

export function checkForUpdates(): UpdateCheckResult {
  const meta = readMeta();
  const currentVersion = getCurrentVersion();
  const dismissed = meta.dismissPermanent || meta.dismissedVersion === currentVersion;

  if (dismissed) {
    return {
      hasUpdates: false,
      currentVersion,
      installedVersion: meta.installedVersion,
      candidates: [],
      dismissed: true,
    };
  }

  const candidates: UpdateCandidate[] = [];
  for (const tpl of enumerateTemplates()) {
    const localContent = getLocalContent(tpl);
    const templateHash = contentHash(tpl.templateContent);
    const installedHash = meta.files[tpl.relativePath]?.hash || null;

    if (localContent === null) {
      candidates.push({
        category: tpl.category,
        relativePath: tpl.relativePath,
        name: tpl.name,
        status: "new",
        templateHash,
        localHash: null,
        installedHash,
      });
      continue;
    }

    const localHash = contentHash(localContent);
    const { meta: fm } = parseYamlFrontmatter(localContent);
    if (fm.source !== "builtin") continue;
    const localVersion = typeof fm.version === "string" ? fm.version : String(fm.version || "0.0.0");
    if (!isVersionLess(localVersion, currentVersion)) continue;

    const status: UpdateStatus = installedHash && installedHash === localHash ? "updated" : "modified";
    candidates.push({
      category: tpl.category,
      relativePath: tpl.relativePath,
      name: tpl.name,
      status,
      templateHash,
      localHash,
      installedHash,
    });
  }

  return {
    hasUpdates: candidates.length > 0,
    currentVersion,
    installedVersion: meta.installedVersion,
    candidates,
    dismissed: false,
  };
}

export function applyUpdates(paths: string[]): { applied: string[]; skipped: string[]; errors: string[] } {
  const meta = readMeta();
  const currentVersion = getCurrentVersion();
  const templates = new Map(enumerateTemplates().map((t) => [t.relativePath, t]));

  const applied: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const p of paths) {
    const tpl = templates.get(p);
    if (!tpl) {
      skipped.push(p);
      continue;
    }

    try {
      if (tpl.category === "rule") {
        const { title, body } = parseRuleTemplate(tpl.templateContent, tpl.relativePath);
        const nextContent = buildRuleDoc(title, body, currentVersion);
        mkdirSync(dirname(tpl.localPath), { recursive: true });
        writeFileSync(tpl.localPath, nextContent, "utf-8");
      } else {
        const nextContent = injectBuiltinFrontmatter(tpl.templateContent, currentVersion);
        mkdirSync(dirname(tpl.localPath), { recursive: true });
        writeFileSync(tpl.localPath, nextContent, "utf-8");
      }

      const written = getLocalContent(tpl);
      if (written) {
        meta.files[p] = { hash: contentHash(written), version: currentVersion };
      }
      applied.push(p);
    } catch (err) {
      errors.push(`${p}: ${String(err)}`);
    }
  }

  meta.installedVersion = currentVersion;
  if (meta.dismissedVersion === currentVersion) meta.dismissedVersion = null;
  writeMeta(meta);

  return { applied, skipped, errors };
}

export function dismissVersion(version: string): void {
  const meta = readMeta();
  meta.dismissedVersion = version;
  writeMeta(meta);
}

export function dismissPermanently(value: boolean): void {
  const meta = readMeta();
  meta.dismissPermanent = value;
  if (!value) meta.dismissedVersion = null;
  writeMeta(meta);
}

export function getUpdateSettings(): { dismissPermanent: boolean; installedVersion: string } {
  const meta = readMeta();
  return {
    dismissPermanent: meta.dismissPermanent,
    installedVersion: meta.installedVersion,
  };
}

export function resetDismiss(): void {
  const meta = readMeta();
  meta.dismissPermanent = false;
  meta.dismissedVersion = null;
  writeMeta(meta);
}

export function seedBuiltinTeam(): void {
  const meta = readMeta();
  const currentVersion = getCurrentVersion();
  const templates = enumerateTemplates();
  let seeded = 0;

  for (const tpl of templates) {
    const localContent = getLocalContent(tpl);
    if (localContent !== null) {
      if (!meta.files[tpl.relativePath]) {
        meta.files[tpl.relativePath] = {
          hash: contentHash(localContent),
          version: currentVersion,
        };
      }
      continue;
    }

    try {
      if (tpl.category === "rule") {
        const { title, body } = parseRuleTemplate(tpl.templateContent, tpl.relativePath);
        const nextContent = buildRuleDoc(title, body, currentVersion);
        mkdirSync(dirname(tpl.localPath), { recursive: true });
        writeFileSync(tpl.localPath, nextContent, "utf-8");
      } else {
        const nextContent = injectBuiltinFrontmatter(tpl.templateContent, currentVersion);
        mkdirSync(dirname(tpl.localPath), { recursive: true });
        writeFileSync(tpl.localPath, nextContent, "utf-8");
      }

      const written = getLocalContent(tpl);
      if (written) {
        meta.files[tpl.relativePath] = { hash: contentHash(written), version: currentVersion };
      }
      seeded += 1;
    } catch (err) {
      logger.error("team-updates", "seed failed", { path: tpl.relativePath, error: String(err) });
    }
  }

  meta.installedVersion = currentVersion;
  writeMeta(meta);
  if (seeded > 0) logger.info("team-updates", "seeded missing builtin team files", { seeded });
}
