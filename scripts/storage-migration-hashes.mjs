#!/usr/bin/env node
/**
 * Print sha256(sql) for every core storage migration of a BUILT tree (dist/).
 *
 * Used to:
 * - (re)generate the frozen list in tests/unit/storage-migration-checksums.test.ts
 * - compare two builds during upgrade checks (e.g. last release vs current)
 *
 * usage: node scripts/storage-migration-hashes.mjs [repoDir=.]
 */
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repo = process.argv[2] ?? '.';
const mod = await import(pathToFileURL(join(repo, 'dist/data/migrations.js')).href);
const migrations = mod.coreStorageMigrations;
if (!Array.isArray(migrations) || !migrations.length) {
  throw new Error(`coreStorageMigrations missing from ${repo}/dist/data/migrations.js`);
}
for (const migration of migrations) {
  console.log(`${migration.id} ${createHash('sha256').update(migration.sql).digest('hex')}`);
}
