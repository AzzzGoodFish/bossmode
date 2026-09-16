import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "../../src/data/database.js";
import { importAgentTemplates } from "../../src/workforce/template-files.js";

/** Explicit historical source fixture, never a current member/template creation API. */
export function importHistoricalAgentTemplate(fixture: {root: string; db: Database}, slug: string, markdown: string): void {
  importAgentTemplates({db: fixture.db, stageAsset(relative, bytes) {
    const path = join(fixture.root, relative);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, bytes);
  }}, [{path: `agents/${slug}.md`, slug, markdown}]);
}
