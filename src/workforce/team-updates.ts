import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync,
  type Dirent,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
  templateHash?: string;  // hash of raw template content (without injected frontmatter)
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
  files?: TemplateAssetFile[];
}

interface TemplateAssetFile {
  relativePath: string;
  content: string;
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

/** Map from legacy rule filenames to canonical names for cleanup */
const LEGACY_RULE_NAMES: Record<string, string> = {
  "rules/dev-team-protocol.md": "rules/team-dev-protocol.md",
  "rules/lite-team-protocol.md": "rules/team-lite-protocol.md",
  "rules/ssot.md": "rules/member-ssot.md",
  "rules/universal-agent-principles.md": "rules/member-universal-principles.md",
};

function readDirectoryFiles(root: string): TemplateAssetFile[] {
  const files: TemplateAssetFile[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]; }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!e.isFile()) continue;
      files.push({
        relativePath: relative(root, abs).replace(/\\/g, "/"),
        content: readFileSync(abs, "utf-8"),
      });
    }
  };
  walk(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

function directoryMaterial(files: TemplateAssetFile[]): string {
  return files.map((f) => `${f.relativePath}\0${f.content}`).join("\0");
}

export function toRulePath(relTemplatePath: string): string {
  const rel = relTemplatePath.replace(/\\/g, "/");
  // team-prompt.md → team-{teamSlug}-protocol.md
  // e.g. dev-team/team-prompt.md → rules/team-dev-protocol.md
  if (rel.endsWith("/team-prompt.md")) {
    const parts = rel.split("/");
    const teamDir = parts[parts.length - 2]; // e.g. "dev-team"
    const teamSlug = teamDir.replace(/-team$/, "");
    return `rules/team-${teamSlug}-protocol.md`;
  }
  // rules/ssot.md → member-ssot.md
  if (rel.includes("/rules/")) {
    const fileName = rel.split("/").pop()!;
    return `rules/member-${fileName}`;
  }
  // universal-agent-principles.md → member-universal-principles.md
  const fileName = rel.split("/").pop()!;
  return `rules/member-${fileName}`;
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
      const skillDir = join(skillsDir, d);
      const skillPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const files = readDirectoryFiles(skillDir);
      out.push({
        category: "skill",
        relativePath: `skills/${d}`,
        name: d,
        templateContent: directoryMaterial(files),
        localPath: join(bossmodeDir(), "skills", d),
        files,
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

  const unique = new Map<string, TemplateFile>();
  for (const tpl of out) {
    if (!unique.has(tpl.relativePath)) unique.set(tpl.relativePath, tpl);
  }

  return Array.from(unique.values()).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
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
  // Strip template frontmatter first (buildRuleDoc will create its own)
  const { meta: fm, body: rawBody } = parseYamlFrontmatter(content);
  let body = rawBody;
  // Extract title from frontmatter, h1 heading, or filename
  let title = typeof fm.title === "string" ? fm.title : "";
  if (!title) {
    const h1 = body.match(/^#\s+(.+)\n/);
    if (h1) {
      title = h1[1].trim();
      body = body.slice(h1[0].length).trimStart();
    } else {
      title = basename(rulePath, ".md").replace(/[-_]/g, " ");
    }
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
    if (!existsSync(tpl.localPath)) return null;
    if (tpl.category === "skill") return directoryMaterial(readDirectoryFiles(tpl.localPath));
    return readFileSync(tpl.localPath, "utf-8");
  } catch {
    return null;
  }
}

function isTrustedBuiltin(tpl: TemplateFile, localContent: string, meta: TeamMetaFile): boolean {
  if (tpl.category === "skill") {
    const skillMd = join(tpl.localPath, "SKILL.md");
    if (existsSync(skillMd)) {
      try {
        const { meta: fm } = parseYamlFrontmatter(readFileSync(skillMd, "utf-8"));
        if (fm.source === "builtin") return true;
      } catch { /* ignore */ }
    }
  } else {
    const { meta: fm } = parseYamlFrontmatter(localContent);
    if (fm.source === "builtin") return true;
  }

  const record = meta.files[tpl.relativePath];
  if (!record) return false;

  const localHash = contentHash(localContent);
  // Legacy built-ins before source frontmatter are trusted only when the
  // tracker can prove this file came from a prior built-in install.
  return record.hash === localHash || Boolean(record.templateHash);
}

function renderTemplate(tpl: TemplateFile, version: string): string {
  if (tpl.category === "rule") {
    const { title, body } = parseRuleTemplate(tpl.templateContent, tpl.relativePath);
    return buildRuleDoc(title, body, version);
  }
  return injectBuiltinFrontmatter(tpl.templateContent, version);
}

function writeTemplate(tpl: TemplateFile, version: string): void {
  if (tpl.category !== "skill") {
    const nextContent = renderTemplate(tpl, version);
    mkdirSync(dirname(tpl.localPath), { recursive: true });
    writeFileSync(tpl.localPath, nextContent, "utf-8");
    return;
  }

  rmSync(tpl.localPath, { recursive: true, force: true });
  for (const file of tpl.files || []) {
    const content = file.relativePath === "SKILL.md" ? injectBuiltinFrontmatter(file.content, version) : file.content;
    const target = join(tpl.localPath, ...file.relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
  }
}

function templateSkillNames(templates: TemplateFile[]): Set<string> {
  return new Set(templates.filter((t) => t.category === "skill").map((t) => t.name));
}

function cleanupDeletedBuiltinSkills(meta: TeamMetaFile, templates: TemplateFile[]): string[] {
  const skillsRoot = join(bossmodeDir(), "skills");
  if (!existsSync(skillsRoot)) return [];

  const activeSkills = templateSkillNames(templates);
  const removed: string[] = [];

  for (const d of readdirSync(skillsRoot)) {
    if (activeSkills.has(d)) continue;
    const skillDir = join(skillsRoot, d);
    const skillMd = join(skillDir, "SKILL.md");
    let isBuiltin = Boolean(meta.files[`skills/${d}`]) || Object.keys(meta.files).some((p) => p.startsWith(`skills/${d}/`));
    if (!isBuiltin && existsSync(skillMd)) {
      try {
        const { meta: fm } = parseYamlFrontmatter(readFileSync(skillMd, "utf-8"));
        isBuiltin = fm.source === "builtin";
      } catch { /* ignore */ }
    }
    if (!isBuiltin) continue;

    rmSync(skillDir, { recursive: true, force: true });
    for (const key of Object.keys(meta.files)) {
      if (key === `skills/${d}` || key.startsWith(`skills/${d}/`)) delete meta.files[key];
    }
    removed.push(`skills/${d}`);
  }

  return removed;
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
  let needsMetaWrite = false;
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
    if (!isTrustedBuiltin(tpl, localContent, meta)) continue;

    // Primary gate: compare template content hash (not version)
    const installedTemplateHash = meta.files[tpl.relativePath]?.templateHash || null;
    if (installedTemplateHash !== null && templateHash === installedTemplateHash) {
      continue;  // Template content unchanged — no update needed
    }

    // Fallback for old meta without templateHash: use version comparison
    if (installedTemplateHash === null) {
      const { meta: fm } = parseYamlFrontmatter(localContent);
      const localVersion = typeof fm.version === "string" ? fm.version : String(fm.version || "0.0.0");
      if (!isVersionLess(localVersion, currentVersion)) {
        // Backfill templateHash silently so next check uses hash-based gate
        meta.files[tpl.relativePath] = {
          ...meta.files[tpl.relativePath],
          templateHash,
        };
        needsMetaWrite = true;
        continue;
      }
    }

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

  // Persist backfilled templateHash values
  if (needsMetaWrite) writeMeta(meta);

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
  const templatesList = enumerateTemplates();
  const templates = new Map(templatesList.map((t) => [t.relativePath, t]));
  const requested = new Set(paths);
  const candidatesBefore = checkForUpdates().candidates.map((c) => c.relativePath);

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
      writeTemplate(tpl, currentVersion);

      const written = getLocalContent(tpl);
      if (written) {
        meta.files[p] = { hash: contentHash(written), version: currentVersion, templateHash: contentHash(tpl.templateContent) };
      }
      applied.push(p);
    } catch (err) {
      errors.push(`${p}: ${String(err)}`);
    }
  }

  if (paths.length > 0) {
    for (const removed of cleanupDeletedBuiltinSkills(meta, templatesList)) applied.push(removed);
  }

  const appliedAllCandidates = candidatesBefore.length > 0
    && candidatesBefore.every((p) => requested.has(p))
    && skipped.length === 0
    && errors.length === 0;
  if (appliedAllCandidates) {
    meta.installedVersion = currentVersion;
    if (meta.dismissedVersion === currentVersion) meta.dismissedVersion = null;
  }
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
          templateHash: contentHash(tpl.templateContent),
        };
      } else if (!meta.files[tpl.relativePath].templateHash) {
        // Backfill templateHash for existing records
        meta.files[tpl.relativePath].templateHash = contentHash(tpl.templateContent);
      }
      continue;
    }

    try {
      writeTemplate(tpl, currentVersion);

      const written = getLocalContent(tpl);
      if (written) {
        meta.files[tpl.relativePath] = { hash: contentHash(written), version: currentVersion, templateHash: contentHash(tpl.templateContent) };
      }
      seeded += 1;
    } catch (err) {
      logger.error("team-updates", "seed failed", { path: tpl.relativePath, error: String(err) });
    }
  }

  // Clean up legacy rule files that were superseded by canonical names
  let cleaned = 0;
  for (const [legacyPath, _canonicalPath] of Object.entries(LEGACY_RULE_NAMES)) {
    const absPath = join(bossmodeDir(), "knowledge", "docs", ...legacyPath.split("/"));
    if (existsSync(absPath)) {
      try {
        unlinkSync(absPath);
        // Remove old meta entry
        delete meta.files[legacyPath];
        cleaned += 1;
        logger.info("team-updates", "removed legacy rule file", { path: legacyPath });
      } catch (err) {
        logger.error("team-updates", "failed to remove legacy rule", { path: legacyPath, error: String(err) });
      }
    }
  }

  const removedSkills = cleanupDeletedBuiltinSkills(meta, templates);

  meta.installedVersion = currentVersion;
  writeMeta(meta);
  if (seeded > 0 || cleaned > 0 || removedSkills.length > 0) {
    logger.info("team-updates", "seeded missing builtin team files", { seeded, cleaned, removedSkills: removedSkills.length });
  }
}
