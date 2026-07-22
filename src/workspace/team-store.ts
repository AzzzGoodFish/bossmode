// Team template store — ~/.bossmode/teams/<slug>/
// Structure (fish-approved):
//   team.md              # frontmatter: name/description/version/leader + body
//   agents/*.md          # self-contained agent copies (skills: frontmatter → team skills/)
//   skills/<name>/SKILL.md (+ *)
//   *                    # other resources (listed, not required)
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { getBossmodeDir } from "../shared/config.js";
const require = createRequire(import.meta.url);
import { parseFrontmatter, asString, asStringArray } from "../shared/frontmatter.js";
import { logger } from "../foundation/logger.js";
import type { AgentDefinition } from "../shared/types.js";

export interface TeamTemplateMeta {
  name: string;
  description: string;
  version: string;
  leader?: string;
  slug: string;
  /** Product-shipped template (synced from templates/teams/). */
  type?: "builtin" | "user";
}

export interface TeamTemplateAgent extends AgentDefinition {
  rawMarkdown: string;
}

export interface TeamTemplateSkillSummary {
  name: string;
  description: string;
  usedBy: string[];
}

export interface TeamTemplate {
  slug: string;
  meta: TeamTemplateMeta;
  teamMdBody: string;
  agents: TeamTemplateAgent[];
  skills: TeamTemplateSkillSummary[];
  otherResources: string[];
}

export interface TeamTemplateSummary {
  slug: string;
  name: string;
  description: string;
  version: string;
  leader?: string;
  agentNames: string[];
  skillNames: string[];
  usedInRoomCount: number;
  builtIn?: boolean;
}

const STANDARD_TOP = new Set(["team.md", "agents", "skills"]);

export function getTeamsDir(): string {
  return join(getBossmodeDir(), "teams");
}

export function ensureTeamsDir(): void {
  const dir = getTeamsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function teamDir(slug: string): string {
  return join(getTeamsDir(), slug);
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "team";
}

function parseAgentMarkdown(content: string, fallbackName: string): TeamTemplateAgent {
  const { meta, body } = parseFrontmatter(content);
  return {
    name: asString(meta.name, fallbackName),
    description: asString(meta.description),
    systemPrompt: body,
    avatar: meta.avatar ? String(meta.avatar) : undefined,
    tags: asStringArray(meta.tags),
    model: meta.model ? asString(meta.model) : undefined,
    skills: meta.skills ? asStringArray(meta.skills) : undefined,
    rawMarkdown: content,
  };
}

function listOtherResources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (dir === root && STANDARD_TOP.has(entry.name)) {
        if (entry.isDirectory() && entry.name !== "agents" && entry.name !== "skills") {
          // only skip standard tops
        } else if (entry.isFile() && entry.name === "team.md") {
          continue;
        } else if (entry.isDirectory() && (entry.name === "agents" || entry.name === "skills")) {
          continue;
        }
      }
      if (dir === root && (entry.name === "team.md" || entry.name === "agents" || entry.name === "skills")) continue;
      if (entry.isDirectory()) walk(abs);
      else out.push(rel.split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function readTeamAt(dir: string, slug: string): TeamTemplate | null {
  const teamMdPath = join(dir, "team.md");
  if (!existsSync(teamMdPath)) return null;
  const raw = readFileSync(teamMdPath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);
  const name = asString(meta.name, slug);
  const description = asString(meta.description);
  const version = asString(meta.version, "1.0.0");
  const leader = meta.leader ? asString(meta.leader) : undefined;

  const agentsDir = join(dir, "agents");
  const agents: TeamTemplateAgent[] = [];
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort()) {
      try {
        const content = readFileSync(join(agentsDir, file), "utf-8");
        agents.push(parseAgentMarkdown(content, file.replace(/\.md$/, "")));
      } catch (err) {
        logger.error("team-store", "failed to parse team agent", { slug, file, error: String(err) });
      }
    }
  }

  const skillsDir = join(dir, "skills");
  const skills: TeamTemplateSkillSummary[] = [];
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillFile)) continue;
      try {
        const content = readFileSync(skillFile, "utf-8");
        const parsed = parseFrontmatter(content);
        const skillName = asString(parsed.meta.name, entry.name);
        const usedBy = agents.filter((a) => (a.skills || []).includes(skillName) || (a.skills || []).includes(entry.name)).map((a) => a.name);
        skills.push({
          name: skillName,
          description: asString(parsed.meta.description),
          usedBy,
        });
      } catch (err) {
        logger.error("team-store", "failed to parse team skill", { slug, skill: entry.name, error: String(err) });
      }
    }
  }

  // Leader first in roster (prototype order).
  if (leader) {
    agents.sort((a, b) => {
      if (a.name === leader) return -1;
      if (b.name === leader) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  const typeRaw = meta.type ? asString(meta.type).toLowerCase() : "";
  const type = typeRaw === "builtin" ? "builtin" as const : "user" as const;

  return {
    slug,
    meta: { name, description, version, leader, slug, type },
    teamMdBody: body,
    agents,
    skills,
    otherResources: listOtherResources(dir),
  };
}

export function listTeamTemplates(): TeamTemplateSummary[] {
  ensureTeamsDir();
  const dir = getTeamsDir();
  const slugs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const usedCounts = countTemplateUsage();
  const out: TeamTemplateSummary[] = [];
  for (const slug of slugs) {
    const team = readTeamAt(teamDir(slug), slug);
    if (!team) continue;
    out.push({
      slug: team.slug,
      name: team.meta.name,
      description: team.meta.description,
      version: team.meta.version,
      leader: team.meta.leader,
      // agents already leader-first from readTeamAt
      agentNames: team.agents.map((a) => a.name),
      skillNames: team.skills.map((s) => s.name),
      usedInRoomCount: usedCounts.get(team.meta.name) || usedCounts.get(slug) || 0,
      builtIn: team.meta.type === "builtin",
    });
  }
  return out;
}

export function getTeamTemplate(nameOrSlug: string): TeamTemplate | null {
  ensureTeamsDir();
  const key = (nameOrSlug || "").trim();
  if (!key) return null;
  const candidates = [key, slugify(key)];
  for (const c of candidates) {
    const direct = teamDir(c);
    if (existsSync(join(direct, "team.md"))) return readTeamAt(direct, c);
  }
  // match by frontmatter name (case-insensitive)
  const lower = key.toLowerCase();
  for (const summary of listTeamTemplates()) {
    if (
      summary.name === key ||
      summary.slug === key ||
      summary.name.toLowerCase() === lower ||
      summary.slug.toLowerCase() === lower
    ) {
      return readTeamAt(teamDir(summary.slug), summary.slug);
    }
  }
  return null;
}

function countTemplateUsage(): Map<string, number> {
  const counts = new Map<string, number>();
  const roomsRoot = join(getBossmodeDir(), "rooms");
  if (!existsSync(roomsRoot)) return counts;
  for (const entry of readdirSync(roomsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const roomPath = join(roomsRoot, entry.name, "room.json");
      if (!existsSync(roomPath)) continue;
      const room = JSON.parse(readFileSync(roomPath, "utf-8")) as { template?: { name?: string } };
      const key = room.template?.name;
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    } catch {
      /* skip bad room */
    }
  }
  return counts;
}

/** Copy a team template directory into dest (overwrites if exists). */
export function copyTeamTemplateTo(slugOrName: string, destDir: string): TeamTemplate {
  const team = getTeamTemplate(slugOrName);
  if (!team) throw new Error(`Team template not found: ${slugOrName}`);
  const src = teamDir(team.slug);
  if (existsSync(destDir)) rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });
  cpSync(src, destDir, { recursive: true });
  return team;
}

/** Write a minimal team package at dest from agent markdown files (migration / blank room). */
export function writeTeamPackage(destDir: string, opts: {
  name: string;
  description?: string;
  version?: string;
  leader?: string;
  agents: Array<{ fileName: string; markdown: string }>;
}): void {
  mkdirSync(join(destDir, "agents"), { recursive: true });
  const version = opts.version || "1.0.0";
  const leaderLine = opts.leader ? `leader: ${opts.leader}\n` : "";
  const teamMd = `---\nname: ${opts.name}\ndescription: ${opts.description || ""}\nversion: ${version}\n${leaderLine}---\n\n# ${opts.name}\n\n${opts.description || "Room team instance."}\n`;
  writeFileSync(join(destDir, "team.md"), teamMd, "utf-8");
  for (const agent of opts.agents) {
    const safe = agent.fileName.endsWith(".md") ? agent.fileName : `${agent.fileName}.md`;
    writeFileSync(join(destDir, "agents", safe), agent.markdown, "utf-8");
  }
}

export function loadRoomTeamAgent(roomId: string, agentName: string): AgentDefinition | null {
  const filePath = join(getBossmodeDir(), "rooms", roomId, "team", "agents", `${agentName}.md`);
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = parseAgentMarkdown(content, agentName);
    const { rawMarkdown: _raw, ...def } = parsed;
    return def;
  } catch (err) {
    logger.error("team-store", "failed to load room team agent", { roomId, agentName, error: String(err) });
    return null;
  }
}

/**
 * Resolve room-local agent; if missing, copy once from the global gallery into
 * the room team package (self-heal / migration edge) then read. Never silently
 * compiles against global without materializing the room-local file.
 */
export function ensureRoomTeamAgent(roomId: string, agentName: string): AgentDefinition | null {
  const existing = loadRoomTeamAgent(roomId, agentName);
  if (existing) return existing;
  try {
    const { loadAgentDefinition } = require("../workforce/agent-store.js") as typeof import("../workforce/agent-store.js");
    const global = loadAgentDefinition(agentName);
    if (!global) return null;
    const teamAgentsDir = join(getBossmodeDir(), "rooms", roomId, "team", "agents");
    mkdirSync(teamAgentsDir, { recursive: true });
    const globalPath = join(getBossmodeDir(), "agents", `${agentName}.md`);
    const dest = join(teamAgentsDir, `${agentName}.md`);
    if (existsSync(globalPath)) {
      writeFileSync(dest, readFileSync(globalPath, "utf-8"), "utf-8");
    } else {
      const skillsLine = global.skills?.length ? `skills: [${global.skills.map((s) => JSON.stringify(s)).join(", ")}]\n` : "";
      writeFileSync(
        dest,
        `---\nname: ${global.name}\ndescription: ${JSON.stringify(global.description || "")}\n${skillsLine}---\n\n${global.systemPrompt || ""}\n`,
        "utf-8",
      );
    }
    if (!existsSync(join(getBossmodeDir(), "rooms", roomId, "team", "team.md"))) {
      writeTeamPackage(join(getBossmodeDir(), "rooms", roomId, "team"), {
        name: roomId,
        description: "Room team",
        version: "1.0.0",
        agents: readdirSync(teamAgentsDir).filter((f) => f.endsWith(".md")).map((f) => ({
          fileName: f,
          markdown: readFileSync(join(teamAgentsDir, f), "utf-8"),
        })),
      });
    }
    return loadRoomTeamAgent(roomId, agentName);
  } catch (err) {
    logger.error("team-store", "ensureRoomTeamAgent failed", { roomId, agentName, error: String(err) });
    return null;
  }
}

export function resolveRoomSkillPaths(roomId: string, skillNames: string[]): string[] {
  const teamSkills = join(getBossmodeDir(), "rooms", roomId, "team", "skills");
  const globalSkills = join(getBossmodeDir(), "skills");
  return skillNames.map((name) => {
    const local = join(teamSkills, name);
    if (existsSync(join(local, "SKILL.md"))) return local;
    const global = join(globalSkills, name);
    if (existsSync(join(global, "SKILL.md"))) return global;
    return local; // prefer local path for error reporting
  });
}

export function importTeamFromZip(zipPath: string): TeamTemplate {
  ensureTeamsDir();
  if (!existsSync(zipPath)) throw new Error("Zip file not found");
  const tmpRoot = join(getBossmodeDir(), ".tmp-team-import", `${Date.now()}`);
  mkdirSync(tmpRoot, { recursive: true });
  try {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", tmpRoot], { stdio: ["ignore", "pipe", "pipe"] });
    // Find directory containing team.md (zip may nest one level)
    let packageDir = tmpRoot;
    if (!existsSync(join(packageDir, "team.md"))) {
      const kids = readdirSync(tmpRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
      const hit = kids.find((k) => existsSync(join(tmpRoot, k.name, "team.md")));
      if (!hit) throw new Error("Invalid team package: team.md not found (required)");
      packageDir = join(tmpRoot, hit.name);
    }
    if (!existsSync(join(packageDir, "agents")) || readdirSync(join(packageDir, "agents")).filter((f) => f.endsWith(".md")).length === 0) {
      throw new Error("Invalid team package: agents/*.md required");
    }
    const parsed = readTeamAt(packageDir, basename(packageDir));
    if (!parsed) throw new Error("Invalid team package: could not parse team.md");
    let slug = slugify(parsed.meta.name || basename(packageDir));
    let dest = teamDir(slug);
    if (existsSync(dest)) {
      slug = `${slug}-${Date.now().toString(36)}`;
      dest = teamDir(slug);
    }
    cpSync(packageDir, dest, { recursive: true });
    const imported = readTeamAt(dest, slug);
    if (!imported) throw new Error("Import failed after copy");
    return imported;
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export function exportTeamToZip(nameOrSlug: string, outZipPath: string): string {
  const team = getTeamTemplate(nameOrSlug);
  if (!team) throw new Error(`Team template not found: ${nameOrSlug}`);
  const src = teamDir(team.slug);
  mkdirSync(dirname(outZipPath), { recursive: true });
  if (existsSync(outZipPath)) rmSync(outZipPath, { force: true });
  execFileSync("zip", ["-qr", outZipPath, "."], { cwd: src, stdio: ["ignore", "pipe", "pipe"] });
  return outZipPath;
}


/** Sync packaged builtin teams from templates/teams/* into ~/.bossmode/teams/.
 * Idempotent: overwrites builtin slugs when packaged template is newer (by version string)
 * or missing; never clobbers user teams (type !== builtin). */
export function syncBuiltinTeamTemplates(): { synced: string[] } {
  const synced: string[] = [];
  const packagedRoot = join(import.meta.dirname, "../../templates/teams");
  if (!existsSync(packagedRoot)) return { synced };
  ensureTeamsDir();
  for (const entry of readdirSync(packagedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(packagedRoot, entry.name);
    if (!existsSync(join(src, "team.md"))) continue;
    const packaged = readTeamAt(src, entry.name);
    if (!packaged || packaged.meta.type !== "builtin") continue;
    const dest = teamDir(entry.name);
    const existing = existsSync(join(dest, "team.md")) ? readTeamAt(dest, entry.name) : null;
    // Skip overwrite of user-owned team that hijacked the slug
    if (existing && existing.meta.type !== "builtin") {
      logger.warn("team-store", "skip builtin sync — slug owned by user team", { slug: entry.name });
      continue;
    }
    // Sync when missing or version differs
    if (!existing || existing.meta.version !== packaged.meta.version) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      cpSync(src, dest, { recursive: true });
      synced.push(entry.name);
      logger.info("team-store", "synced builtin team template", { slug: entry.name, version: packaged.meta.version });
    }
  }
  return { synced };
}

/** Seed default team templates from packaged agents (idempotent). */
export function seedDefaultTeamTemplatesFromAgents(): { created: string[] } {
  ensureTeamsDir();
  // Always sync product-shipped builtin teams first.
  try { syncBuiltinTeamTemplates(); } catch (err) {
    logger.error("team-store", "builtin team sync failed", { error: String(err) });
  }
  const created: string[] = [];
  const existing = listTeamTemplates();
  // If any team exists (including builtin Dev Team), skip Default Team seed.
  if (existing.length > 0) return { created };

  const agentsDir = join(getBossmodeDir(), "agents");
  const templateAgentsDir = join(import.meta.dirname, "../../templates/agents");
  const sourceDir = existsSync(agentsDir) && readdirSync(agentsDir).some((f) => f.endsWith(".md"))
    ? agentsDir
    : templateAgentsDir;
  if (!existsSync(sourceDir)) return { created };

  const agentFiles = readdirSync(sourceDir).filter((f) => f.endsWith(".md") && f !== "summarizer.md");
  if (agentFiles.length === 0) return { created };

  const slug = "default-team";
  const dest = teamDir(slug);
  if (existsSync(join(dest, "team.md"))) return { created };

  const agents = agentFiles.map((file) => ({
    fileName: file,
    markdown: readFileSync(join(sourceDir, file), "utf-8"),
  }));
  const names = agents.map((a) => a.fileName.replace(/\.md$/, ""));
  const leader = names.includes("pm") ? "pm" : names[0];
  writeTeamPackage(dest, {
    name: "Default Team",
    description: "Seeded from local agent library",
    version: "1.0.0",
    leader,
    agents,
  });
  created.push(slug);
  logger.info("team-store", "seeded default team template", { slug, agents: names.length });
  return { created };
}

export function assertPathInside(base: string, target: string): string {
  const resolved = resolve(target);
  const root = resolve(base);
  if (resolved !== root && !resolved.startsWith(root + "/")) {
    throw new Error("Path escapes team directory");
  }
  return resolved;
}

// silence unused import warning for statSync if any
