/**
 * dsh-skills-mcp-group-manager 消融运行脚本（ablation/run.mjs）
 *
 * 对每个变体：
 *   - code 变体（M1..M5）：git apply variants/<ID>.patch → 跑探针 → git
 *     checkout 恢复 lib/index.js；
 *   - M6（静态验证）：直接跑探针（无 patch）。
 * 结果写入 ablation/results.json，并打印摘要。
 *
 * 用法：node ablation/run.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const CODE_VARIANTS = ['M1', 'M2', 'M3', 'M4', 'M5'];
const STATIC_VARIANTS = ['M6'];
const ALL = [...CODE_VARIANTS, ...STATIC_VARIANTS];

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
}

const results = [];
for (const variant of ALL) {
  let applied = false;
  try {
    if (CODE_VARIANTS.includes(variant)) {
      run('git', ['apply', path.join('ablation', 'variants', variant + '.patch')]);
      applied = true;
    }
    const out = run('node', ['ablation/probe.mjs', variant]);
    const parsed = JSON.parse(out.trim().split('\n').pop());
    results.push(parsed);
    console.log(`${parsed.pass ? 'PASS' : 'FAIL'} ${variant}: ${parsed.note}`);
    for (const [k, v] of Object.entries(parsed.checks)) {
      if (v !== 'ok') console.log(`      ${k}: ${v}`);
    }
  } catch (err) {
    results.push({
      variant,
      loadOk: false,
      checks: { run: 'FAIL: ' + String(err?.message ?? err) },
      pass: false,
      note: 'run error',
    });
    console.log(`ERROR ${variant}: ${String(err?.message ?? err)}`);
  } finally {
    if (applied) {
      run('git', ['checkout', '--', 'lib/index.js']);
    }
  }
}

fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2));
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} variants passed`);
