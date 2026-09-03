/**
 * Batch 6 §1.2 migration: platform MCP config → member-owned mcp.json.
 *
 * Behavior-invariant rule (pm product gate 2026-09-03): for each member, copy
 * only the servers on its current enable list (mcpServers[]) from the platform
 * config into members/<id>/mcp.json. Members with no/empty list get NO file —
 * their现状 is "no MCP" and migration must not change that. Members that
 * already have an mcp.json are skipped (presence = done).
 *
 * After applying, the platform config file is archived in place (renamed to
 * mcp.json.pre-batch6) so the legacy source can never feed a session again.
 * The runtime/ directory (oauth + scoped configs) stays — it is live state.
 *
 * Dry-run is the default; pass dryRun: false (or --apply on the CLI) to write.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";
import {
  getBossmodeMcpConfigPath,
  getAssignableMcpServerNames,
  getMcpServersObject,
  getMemberMcpConfigPath,
  disableDeferredMcpCapabilities,
} from "../shared/mcp-settings.js";
import { listMembers } from "./member-registry.js";
import { memberDir } from "./member-profile.js";

export interface MemberAssetsMigrationReport {
  ran: boolean;
  dryRun: boolean;
  platformConfigExists: boolean;
  members: Array<{ memberId: string; name: string; action: "created" | "skipped-existing" | "no-list" | "would-create"; serverCount: number }>;
  platformArchived: boolean;
}

export function needsMemberAssetsMigration(): boolean {
  const platformPath = getBossmodeMcpConfigPath();
  if (!existsSync(platformPath)) return false;
  // Migration is done when the platform file is gone (archived).
  for (const m of listMembers()) {
    const list = Array.isArray((m as any).global?.mcpServers) ? (m as any).global.mcpServers as string[] : [];
    if (list.length > 0 && !existsSync(getMemberMcpConfigPath(m.id))) return true;
  }
  return false;
}

export function runMemberAssetsMigration(opts: { dryRun?: boolean } = {}): MemberAssetsMigrationReport {
  const dryRun = opts.dryRun !== false;
  const platformPath = getBossmodeMcpConfigPath();
  const report: MemberAssetsMigrationReport = {
    ran: true,
    dryRun,
    platformConfigExists: existsSync(platformPath),
    members: [],
    platformArchived: false,
  };
  if (!report.platformConfigExists) return report;

  let platformConfig: Record<string, unknown> = {};
  try {
    platformConfig = JSON.parse(readFileSync(platformPath, "utf-8"));
  } catch {
    // Unreadable platform config: nothing safe to migrate.
    return report;
  }
  const platformServers = getMcpServersObject(platformConfig);
  const assignable = new Set(getAssignableMcpServerNames(platformConfig));

  let anyCreated = false;
  for (const m of listMembers()) {
    const list = Array.isArray((m as any).global?.mcpServers) ? (m as any).global.mcpServers as string[] : [];
    const memberPath = getMemberMcpConfigPath(m.id);
    if (existsSync(memberPath)) {
      report.members.push({ memberId: m.id, name: m.name, action: "skipped-existing", serverCount: 0 });
      continue;
    }
    if (list.length === 0) {
      // Behavior invariant: no list → no file (现状 = 没有 MCP).
      report.members.push({ memberId: m.id, name: m.name, action: "no-list", serverCount: 0 });
      continue;
    }
    const filtered: Record<string, unknown> = {};
    for (const name of list) {
      if (assignable.has(name) && platformServers[name] !== undefined) {
        filtered[name] = disableDeferredMcpCapabilities(platformServers[name]);
      }
    }
    report.members.push({
      memberId: m.id,
      name: m.name,
      action: dryRun ? "would-create" : "created",
      serverCount: Object.keys(filtered).length,
    });
    if (!dryRun) {
      mkdirSync(memberDir(m.id), { recursive: true });
      writeFileSync(memberPath, `${JSON.stringify({ mcpServers: filtered }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      try { chmodSync(memberPath, 0o600); } catch { /* best effort */ }
      anyCreated = true;
    } else {
      anyCreated = true;
    }
  }

  // Archive the platform file once every listed member is settled (created or
  // skipped). Non-listed members were invariant-untouched by design.
  const unsettled = report.members.some((e) => e.action === "would-create");
  if (!dryRun && !unsettled && anyCreated) {
    renameSync(platformPath, `${platformPath}.pre-batch6`);
    report.platformArchived = true;
  }
  return report;
}

/** Daemon startup hook: apply once, silently, never blocking listen. */
export function runMemberAssetsMigrationOnStartup(): void {
  try {
    if (!needsMemberAssetsMigration()) return;
    const report = runMemberAssetsMigration({ dryRun: false });
    console.log(`[member-assets-migration] applied: ${report.members.filter((e) => e.action === "created").length} member mcp.json written, platform archived=${report.platformArchived}`);
  } catch (err) {
    console.error(`[member-assets-migration] failed (non-fatal):`, err);
  }
}
