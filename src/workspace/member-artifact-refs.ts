/**
 * 0.20 read-side key merge (pre-F5 bridge).
 *
 * A member's activity artifacts (agent-events/<ref>.jsonl + <ref>.stats.json)
 * may exist under several key forms in the same room:
 * - `mem_<uuid>` — current global-member key (0.20+)
 * - `rm_<uuid>` — legacy room-local member id (pre-0.20 rooms)
 * - bare name — pre-0.20 writes keyed by member name
 *
 * Reads (panel stats/activity) merge across every existing form so pre-0.20
 * history stays visible; the F5 rekey migration converges the files later.
 * This module is the single place that knows the key forms — F5 only touches
 * here and the writers, never the consumers.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getBossmodeDir } from "../shared/config.js";

/**
 * Candidate artifact refs for one member in one scope, in authority order
 * (mem_ first). `memberIds`/`memberNames` carry every known identity form the
 * caller resolved (global member id/name + matching room-member records).
 */
export function listMemberArtifactRefs(
  artifactKey: string,
  identities: Array<{ id?: string | null; name?: string | null }>,
): string[] {
  const dir = join(getBossmodeDir(), "rooms", artifactKey, "agent-events");
  if (!existsSync(dir)) return [];
  const want = new Set<string>();
  for (const ident of identities) {
    if (ident.id) want.add(ident.id);
    if (ident.name) want.add(ident.name);
  }
  const found: string[] = [];
  for (const file of readdirSync(dir)) {
    const match = file.match(/^(.*)(?:\.jsonl|\.stats\.json)$/);
    if (match && want.has(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  // mem_ first (current authority), then legacy forms — stable, deterministic.
  return found.sort((a, b) => Number(b.startsWith("mem_")) - Number(a.startsWith("mem_")) || a.localeCompare(b));
}
