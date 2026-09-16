import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
const root=process.env.BOSSMODE_TEST_ROOT;
if(!root || !resolve(root).startsWith(resolve(tmpdir())+'/bossmode-test-run-') || readFileSync(join(root,'.bossmode-test-sandbox'),'utf8')!=='bossmode-test-run-v1\n') {
 throw new Error('Tests require the isolated launcher: npm test -- <vitest arguments>. Never run against a live BOSSMODE_DIR.');
}
if(realpathSync(root)===resolve(homedir(),'.bossmode')) throw new Error('Production Bossmode directory is forbidden for tests');
// This runs before test-file imports; beforeEach alone is too late for files/layout.ts.
// Each test file gets its own asset root before application imports. SQL is still opt-in.
process.env.BOSSMODE_DIR=mkdtempSync(join(realpathSync(root),'suite-'));
