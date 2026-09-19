#!/usr/bin/env node
// Enforce dependency direction, resolvable imports, cycles, and SDK boundaries.
// Size and the historical target tree are reported as reference metrics only.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const dependencies = {
  kernel: ['kernel'], data: ['data', 'kernel'], files: ['files', 'kernel'],
  config: ['config', 'data', 'files', 'kernel'],
  member: ['member', 'data', 'files', 'kernel'],
  chat: ['chat', 'data', 'files', 'kernel'],
  agent: ['agent', 'config', 'data', 'files', 'kernel'],
  knowledge: ['knowledge', 'member', 'data', 'files', 'kernel'],
  api: ['api', 'member', 'chat', 'config', 'files', 'kernel'],
  app: ['app', 'api', 'knowledge', 'agent', 'member', 'chat', 'config', 'data', 'files', 'kernel'],
};
const apiAgentFiles = new Set(['types', 'controls', 'events', 'tools', 'terminal'].map(n => `src/agent/${n}.ts`));
const adapter = p => p.startsWith('src/agent/runtime/') || p.startsWith('src/config/pi-adapt/');
const lines = text => (text.match(/\n/g) || []).length + (text && !text.endsWith('\n') ? 1 : 0);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const count = (map, key) => { map[key] = (map[key] || 0) + 1; };

function sourceFiles(root, dir = 'src') {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(e => {
    const path = `${dir}/${e.name}`;
    if (e.isSymbolicLink()) throw new Error(`Source symlinks are not allowed: ${path}`);
    if (e.isDirectory()) return sourceFiles(root, path);
    return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ? [] : [path];
  }).sort();
}
function importSpecifiers(node, result = []) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) result.push(node.moduleSpecifier);
  else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) result.push(node.argument.literal);
  else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
    if (node.arguments[0]) result.push(node.arguments[0]);
  }
  ts.forEachChild(node, child => { importSpecifiers(child, result); });
  return result;
}
function permitted(from, to) {
  const a = from.split('/')[1], b = to.split('/')[1];
  if (a === 'api') {
    if (from === 'src/api/auth.ts' && b === 'data') return true;
    if (apiAgentFiles.has(to) || to === 'src/app/member-actions.ts' || to === 'src/knowledge/documents.ts') return true;
    if (adapter(to)) return false;
  }
  // Application use cases must never depend on the transport/composition root.
  if (from === 'src/app/member-actions.ts' && (b === 'api' || to.startsWith('src/app/'))) return false;
  return dependencies[a]?.includes(b) ?? false;
}
function scan(root) {
  const files = sourceFiles(root), known = new Set(files), violations = {}, graph = new Map();
  const totals = { files: files.length, lines: 0, normalizedLines: 0, bytes: 0 };
  for (const path of files) {
    const text = readFileSync(resolve(root, path), 'utf8');
    totals.lines += lines(text); totals.bytes += Buffer.byteLength(text);
    if (!/\.[cm]?[jt]sx?$/.test(path)) {
      totals.normalizedLines += text.split('\n').filter(l => l.trim()).length;
      continue;
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`Invalid source syntax: ${path}`);
    totals.normalizedLines += printer.printFile(source).split('\n').filter(l => l.trim()).length;
    const edges = new Set(); graph.set(path, edges);
    for (const node of importSpecifiers(source)) {
      if (!ts.isStringLiteralLike(node)) {
        // The sole extension loader necessarily resolves member-owned entry paths.
        if (path !== 'src/agent/runtime/resources.ts') count(violations, `dynamic-import|${path}|${node.getText(source)}`);
        continue;
      }
      const spec = node.text;
      if (spec.startsWith('@earendil-works/') && !adapter(path)) count(violations, `sdk|${path}|${spec}`);
      if (!spec.startsWith('.')) continue;
      const base = relative(root, resolve(root, dirname(path), spec)).replaceAll('\\', '/');
      const stem = base.replace(/\.[cm]?js$/, '');
      const target = [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`].find(p => known.has(p));
      if (!target) { count(violations, `unresolved|${path}|${spec}`); continue; }
      edges.add(target);
      if (!permitted(path, target)) count(violations, `dependency|${path}|${target}`);
    }
  }
  // Cycles are checked on file edges, not directory-name pairs. Type imports count.
  let index = 0; const stack = [], indexes = new Map(), low = new Map(), active = new Set();
  function visit(path) {
    indexes.set(path, index); low.set(path, index++); stack.push(path); active.add(path);
    for (const to of graph.get(path) || []) {
      if (!indexes.has(to)) { visit(to); low.set(path, Math.min(low.get(path), low.get(to))); }
      else if (active.has(to)) low.set(path, Math.min(low.get(path), indexes.get(to)));
    }
    if (low.get(path) !== indexes.get(path)) return;
    const component = []; let current;
    do { current = stack.pop(); active.delete(current); component.push(current); } while (current !== path);
    if (component.length > 1) {
      const inside = new Set(component);
      for (const from of component) for (const to of graph.get(from) || []) if (inside.has(to)) count(violations, `cycle|${from}|${to}`);
    }
  }
  for (const path of graph.keys()) if (!indexes.has(path)) visit(path);
  return { files, totals, violations };
}

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = resolve(rootIndex < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : args[rootIndex + 1]);
const policy = JSON.parse(readFileSync(resolve(root, 'scripts/architecture-target.json'), 'utf8'));
const baselinePath = resolve(root, 'scripts/architecture-baseline.json');
const target = new Set(policy.files);
if (target.size !== policy.files.length) throw new Error('Invalid target file manifest');
const current = scan(root);
if (args.includes('--init')) {
  if (existsSync(baselinePath)) throw new Error('Refusing to replace an existing baseline');
  writeFileSync(baselinePath, JSON.stringify({ version: 2, ref: policy.baselineRef, totals: current.totals,
    legacyFiles: current.files.filter(p => !target.has(p)), violations: current.violations }, null, 2) + '\n');
  console.log('Initialized file-level baseline; this is not final architecture acceptance.');
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
if (baseline.version !== 2 || baseline.ref !== policy.baselineRef) throw new Error('Architecture baseline/target mismatch');
const errors = [];
for (const [key, n] of Object.entries(current.violations)) {
  if (n > (baseline.violations[key] || 0)) errors.push(`${key}: ${baseline.violations[key] || 0} -> ${n}`);
}
const outsideTarget = current.files.filter(p => !target.has(p));
const missingTarget = policy.files.filter(p => !current.files.includes(p));
if (args.includes('--final')) {
  for (const key of Object.keys(current.violations)) errors.push(`Architecture violation remains: ${key}`);
}
console.log(`Backend: ${current.totals.files} files, ${current.totals.lines} lines, ${current.totals.normalizedLines} normalized lines`);
console.log(`Reference target: ${target.size} files; reference limits ${JSON.stringify(policy.limits)}`);
console.log(`Target-tree differences: +${outsideTarget.length}/-${missingTarget.length}; violating file edges: ${Object.keys(current.violations).length}`);
if (args.includes('--report')) {
  for (const path of outsideTarget) console.log(`  +tree ${path}`);
  for (const path of missingTarget) console.log(`  -tree ${path}`);
  for (const [key, n] of Object.entries(current.violations)) console.log(`  ${n} ${key}`);
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else if (args.includes('--ratchet')) {
  writeFileSync(baselinePath, JSON.stringify({ ...baseline, legacyFiles: outsideTarget, violations: current.violations }, null, 2) + '\n');
  console.log('Removed resolved dependency exceptions; no new exception was admitted.');
} else console.log(args.includes('--final') ? 'Dependency architecture accepted; size/tree metrics are informational.' : 'No architecture regression. Final dependency acceptance remains a separate required gate.');
