#!/usr/bin/env node
// check-architecture.mjs — 架构依赖守护（重构片 0：燃烧线基线）
//
// 规则 v0：
//   1. 基线冻结：重构开始时把 src/ 的「跨模块引用」冻结进 scripts/architecture-baseline.json。
//   2. 只减不增：冻结的「模块对」计数不得增加；旧模块之间不得出现新的模块对。
//   3. 新模块自由期：不属于基线模块列表的新模块，其引用边照常记录（不拦截），
//      待该模块所属重构片评审时按目标规则（kernel/config/data/files/agent/member/chat/api/app）校验。
//   4. 每个重构片应让燃烧线（冻结引用总条数）下降；持平需在片日志说明。
//
// 用法：
//   node scripts/check-architecture.mjs            # 检查（门禁）；有违规 exit 1
//   node scripts/check-architecture.mjs --report   # 同检查，附带更详细的报告
//   node scripts/check-architecture.mjs --update   # 人工刷新基线（模块整体替换/重命名时，走审查后使用）
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const SRC = join(ROOT, "src");
const BASELINE_PATH = join(SCRIPT_DIR, "architecture-baseline.json");

const mode = process.argv.includes("--update") ? "update" : process.argv.includes("--report") ? "report" : "check";

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function topMod(abs) {
  const rel = relative(SRC, abs).split(sep);
  return rel[0];
}

const importRe = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function resolveSpec(fromFile, spec) {
  let base = normalize(join(dirname(fromFile), spec));
  const cands = [];
  if (base.endsWith(".js")) cands.push(base.slice(0, -3) + ".ts");
  cands.push(base, base + ".ts", join(base, "index.ts"));
  for (const c of cands) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function computeEdges() {
  const files = walk(SRC);
  const pairs = new Map();      // "a->b" -> count
  const unresolved = new Map(); // spec -> count
  for (const f of files) {
    const from = topMod(f);
    const text = readFileSync(f, "utf8");
    let g;
    importRe.lastIndex = 0;
    while ((g = importRe.exec(text))) {
      const spec = g[1];
      if (!spec.startsWith(".")) continue;
      const target = resolveSpec(f, spec);
      if (!target) { unresolved.set(spec, (unresolved.get(spec) || 0) + 1); continue; }
      const to = topMod(target);
      if (to === from) continue;
      const key = `${from}->${to}`;
      pairs.set(key, (pairs.get(key) || 0) + 1);
    }
  }
  return { pairs, unresolved, fileCount: files.length };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`ABORT: baseline missing (${BASELINE_PATH}). Run with --update to freeze the current state.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function refOfHead() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const current = computeEdges();

if (mode === "update") {
  const modules = [...new Set([...current.pairs.keys()].flatMap(k => k.split("->")))].sort();
  const baseline = {
    frozenAt: new Date().toISOString().slice(0, 10),
    frozenRef: refOfHead(),
    note: "Architecture refactor burn-line baseline (see refactor-execution-plan). Only shrink; refreeze = review.",
    modules,
    pairs: Object.fromEntries([...current.pairs.entries()].sort()),
    totalRefs: [...current.pairs.values()].reduce((a, b) => a + b, 0),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`baseline written: ${modules.length} modules, ${Object.keys(baseline.pairs).length} pairs, ${baseline.totalRefs} refs`);
  process.exit(0);
}

const baseline = loadBaseline();
const legacy = new Set(baseline.modules);
const violations = [];
let burned = 0;
const removedPairs = [];
const shrunkPairs = [];
const newEdges = [];

for (const [pair, baseCount] of Object.entries(baseline.pairs)) {
  const cur = current.pairs.get(pair) || 0;
  if (cur > baseCount) violations.push(`${pair}: ${baseCount} -> ${cur} (increase)`);
  else if (cur < baseCount) { burned += baseCount - cur; (cur === 0 ? removedPairs : shrunkPairs).push(`${pair}: ${baseCount} -> ${cur}`); }
}

for (const [pair, cur] of current.pairs.entries()) {
  const [from, to] = pair.split("->");
  const inBaseline = Object.prototype.hasOwnProperty.call(baseline.pairs, pair);
  if (inBaseline) continue;
  if (legacy.has(from) && legacy.has(to)) violations.push(`${pair}: new pair (${cur} refs)`);
  else newEdges.push(`${pair}: ${cur}`);
}

const curLegacyTotal = [...current.pairs.entries()]
  .filter(([pair]) => pair.split("->").every(m => legacy.has(m)))
  .reduce((a, [, c]) => a + c, 0);

// Quarantine rule (P5): @earendil-works/* is importable only from the marked adapter zones.
const QUARANTINE_ALLOW = ["src/engine/runtime/", "src/config/pi-adapt/"];
const quarantine = [];
for (const abs of walk(SRC)) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  if (QUARANTINE_ALLOW.some((a) => rel.startsWith(a))) continue;
  if (/@earendil-works\//.test(readFileSync(abs, "utf8"))) quarantine.push(rel);
}
if (quarantine.length) violations.push(...quarantine.map((f) => `quarantine: ${f} imports @earendil-works/* (allowed: engine/runtime/**, config/pi-adapt/**)`));

console.log(`modules: ${baseline.modules.length} frozen; src files scanned: ${current.fileCount}`);
console.log(`burn line: ${baseline.totalRefs} frozen refs -> ${curLegacyTotal} current (burned ${burned})`);
if (mode === "report") console.log(`  quarantine: ${quarantine.length === 0 ? "clean" : quarantine.join(", ")} (allowed: ${QUARANTINE_ALLOW.join(", ")})`);
if (removedPairs.length) console.log(`  removed: ${removedPairs.join(", ")}`);
if (shrunkPairs.length && mode === "report") console.log(`  shrunk: ${shrunkPairs.join(", ")}`);
if (newEdges.length) console.log(`  new-module edges (recorded): ${newEdges.length}${mode === "report" ? " -> " + newEdges.join(", ") : ""}`);
if (current.unresolved.size) console.log(`  unresolved imports: ${current.unresolved.size} distinct specs`);

if (violations.length) {
  console.error(`\nArchitecture guard FAILED (${violations.length}):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("\nArchitecture guard passed.");
