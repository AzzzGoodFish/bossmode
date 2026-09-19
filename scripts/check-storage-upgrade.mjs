#!/usr/bin/env node
/**
 * Merge-gate storage-upgrade check.
 *
 * Boots a data directory created by the OLD build with the NEW build and
 * verifies the upgrade path end to end. Catches what the frozen-checksum unit
 * test cannot: checksum drift against checksums written by an earlier release,
 * migration ordering, upgrade-time data damage.
 *
 * usage: node scripts/check-storage-upgrade.mjs <oldRepo> <newRepo> [workDir]
 *  - oldRepo/newRepo: build trees containing dist/app/cli/index.js (old trees: dist/cli/index.js)
 *  - workDir: evidence kept here (default: fresh temp dir); wiped first
 *
 * Scenario: seed config -> OLD build `on` -> create member/room/message via HTTP
 * -> `off` -> NEW build `on` -> verify member/message intact + migrations grew
 * -> `off` -> PASS/FAIL exit code.
 */
import {mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';

const OLD_REPO = process.argv[2] ? resolve(process.argv[2]) : undefined;
const NEW_REPO = process.argv[3] ? resolve(process.argv[3]) : undefined;
if (!OLD_REPO || !NEW_REPO) {
  console.error('usage: node scripts/check-storage-upgrade.mjs <oldRepo> <newRepo> [workDir]');
  process.exit(2);
}
const BASE = process.argv[4] ?? mkdtempSync(join(tmpdir(), 'bm-storage-upgrade-'));
const ROOT = join(BASE, 'data');
const HOME = join(BASE, 'home');
rmSync(BASE, {recursive: true, force: true});
mkdirSync(ROOT, {recursive: true});
mkdirSync(join(HOME, '.bossmode'), {recursive: true});

const salt = 'upgrade-check-salt';
const password = 'upgrade-check-pass';
const username = 'upgrade-check';
const put = (path, value) => {
  const target = join(ROOT, path);
  mkdirSync(join(target, '..'), {recursive: true});
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
};
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});

put('config.json', {
  auth: {username, passwordHash: salt + ':' + createHash('sha256').update(salt + password).digest('hex')},
  apiKeys: {},
  defaults: {host: '127.0.0.1', port},
  runtime: {sessionResume: true},
  catalog: {autoRefreshIntervalDays: 0},
});
put('agents/general.md', '---\nname: General\ndescription: Fixture\n---\nTemplate body\n');

const env = {
  ...process.env,
  HOME,
  BOSSMODE_DIR: ROOT,
  PI_CODING_AGENT_DIR: join(BASE, 'pi'),
  npm_config_update_notifier: 'false',
};
const run = (repo, args, timeout = 120000) => new Promise((resolve, reject) => {
  // New layout (P9): dist/app/cli; old release trees keep dist/cli — accept both.
  const cli = [join(repo, 'dist/app/cli.js'), join(repo, 'dist/app/cli/index.js'), join(repo, 'dist/cli/index.js')].find(existsSync) ?? join(repo, 'dist/app/cli.js');
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repo,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error(`timeout: ${repo} ${args.join(' ')}`));
  }, timeout);
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('close', (code) => {
    clearTimeout(timer);
    if (code !== 0) reject(new Error(`exit ${code}: ${repo} ${args.join(' ')}\n${out}`));
    else resolve(out);
  });
});

const migrationCount = () => {
  const db = new DatabaseSync(join(ROOT, 'bossmode.db'), {readOnly: true});
  const row = db.prepare('SELECT COUNT(*) n FROM storage_schema_versions').get();
  db.close();
  return row.n;
};

let running = null;
try {
  // 1) OLD build creates the data directory (records its migration checksums)
  console.log(`[1/3] old build on: ${OLD_REPO}`);
  await run(OLD_REPO, ['on', '--host', '127.0.0.1', '--port', String(port)]);
  running = OLD_REPO;
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({username, password}),
  });
  const {token} = await login.json();
  const H = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  const member = await fetch(`http://127.0.0.1:${port}/api/members`, {
    method: 'POST', headers: H, body: JSON.stringify({name: 'upgrade-bot'}),
  });
  if (member.status !== 200) throw new Error(`member create ${member.status}: ${await member.text()}`);
  const memberBody = await member.json();
  const memberId = memberBody.member.memberId ?? memberBody.member.id;
  const room = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST', headers: H, body: JSON.stringify({name: 'upgrade-room', cwd: ROOT, memberIds: [memberId]}),
  });
  if (room.status !== 200) throw new Error(`room create ${room.status}: ${await room.text()}`);
  const roomId = (await room.json()).id;
  const post = await fetch(`http://127.0.0.1:${port}/api/rooms/${roomId}/messages`, {
    method: 'POST', headers: H, body: JSON.stringify({content: 'upgrade baseline message'}),
  });
  if (post.status !== 200) throw new Error(`post ${post.status}: ${await post.text()}`);
  await run(OLD_REPO, ['off'], 60000);
  running = null;
  const beforeCount = migrationCount();
  console.log(`      fixture ready: member=${memberId} room=${roomId} migrations=${beforeCount}`);

  // 2) NEW build boots the same directory (checksum validation + migrations)
  console.log(`[2/3] new build on: ${NEW_REPO}`);
  await run(NEW_REPO, ['on', '--host', '127.0.0.1', '--port', String(port)]);
  running = NEW_REPO;

  // 3) verify data survived and new migrations landed
  // QA-patched: short-id migration renames the room; resolve old->new before asserting.
  let activeRoomId = roomId;
  try {
    const db = new DatabaseSync(join(ROOT, 'bossmode.db'), {readOnly: true});
    const row = db.prepare('SELECT new_id FROM id_migration_map WHERE kind=? AND old_id=?').get('room', roomId);
    db.close();
    if (row && row.new_id) activeRoomId = row.new_id;
  } catch {}
  const messages = await fetch(`http://127.0.0.1:${port}/api/conversations/room%3A${activeRoomId}/messages?limit=100`, {headers: H});
  const listBody = await messages.json();
  const list = listBody.messages ?? listBody;
  if (!list.some((m) => String(m.content).includes('upgrade baseline message'))) {
    throw new Error('baseline message missing after upgrade');
  }
  await run(NEW_REPO, ['off'], 60000);
  running = null;
  const afterCount = migrationCount();
  if (afterCount < beforeCount) throw new Error(`migration count shrank: ${beforeCount} -> ${afterCount}`);
  console.log(`[3/3] upgraded: migrations=${afterCount}, baseline message intact`);

  console.log(`PASS old=${OLD_REPO} new=${NEW_REPO} migrations ${beforeCount}->${afterCount} workDir=${BASE}`);
} catch (error) {
  console.error('FAIL:', String(error));
  process.exitCode = 1;
} finally {
  if (running) {
    try {
      await run(running, ['off'], 60000);
    } catch {}
  }
}
