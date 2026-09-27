// test/bake.test.mjs — the pipeline itself, under test.
//
// js/data/lots.js opens with "audit with `node test/book.test.mjs` and `node test/bake.test.mjs`",
// so this file is the second half of that promise: it RUNS the bake, twice, and holds three things
//   1. the output is reproducible — same bytes except the BAKED_AT stamp;
//   2. the bake's own zero-counters are still zero (no disagreement, no non-unique win, no
//      margin = 0, no loss with a choice);
//   3. the three length identities the docs quote hold over the whole shipped grid, and the one
//      naive claim that does NOT — 帕 == 除法数 — is counted false 961 times out of 1830.
//
// The bake writes js/data/lots.js; this suite saves the shipped bytes first and restores them in a
// finally block, so running the suite can never leave the repo holding a different book.
//   node test/bake.test.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run, test, ok, eq } from '../tools/harness.mjs';
import { cfLength, cfQuotients, margin, pairKey, squareCount } from '../js/core/euclid.js';
import { lineThrough, solve, table, census as retroCensus } from '../js/core/retro.js';
import { depth as gDepth, isLoss as gIsLoss, reconcile, slowSteps, winningMoves, census as phiCensus } from '../js/core/golden.js';
import { encodeBook } from '../js/core/book.js';
import { BANDS, BOOK_BOUND, candidates } from '../js/core/make.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const lotsPath = join(root, 'js', 'data', 'lots.js');
const shippedBytes = readFileSync(lotsPath);

// A bake run with the wide φ sweep trimmed to the shipped bound: the same code path, seconds not
// minutes. PHI_CENSUS_MAXA is the bake's own dial.
function bake() {
  const out = execFileSync(process.execPath, ['tools/bake.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PHI_CENSUS_MAXA: '60' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { out: out + '', bytes: readFileSync(lotsPath) };
}

const stripStamp = (buf) => buf.toString('utf8').replace(/^export const BAKED_AT = .*$/m, '');

let firstRun = null;

test('bake: 跑两遍就写完文件，退出码 0（第一遍）', () => {
  try {
    firstRun = bake();
  } finally {
    restoreShipped();
  }
  ok(firstRun.out.includes('wrote 32 lots'), firstRun.out.slice(-400));
  ok(/route1 grid a<=60: 1830 positions/.test(firstRun.out), firstRun.out);
});

function restoreShipped() {
  writeFileSync(lotsPath, shippedBytes);
}

test('bake: 两遍写出的字节完全相同（除了 BAKED_AT 那一行时间戳）', () => {
  let second = null;
  try {
    second = bake();
  } finally {
    restoreShipped();
  }
  const a = stripStamp(firstRun.bytes);
  const b = stripStamp(second.bytes);
  eq(a === b, true, '两次烘焙的产物不同：还有别的时间/顺序依赖漏在管线里');
  ok(/^export const BAKED_AT = "\d{4}-\d{2}-\d{2}T/m.test(firstRun.bytes.toString('utf8')), 'BAKED_AT 必须存在');
  // the shipped file we restored is byte-identical to what the bake would write, minus the stamp
  eq(stripStamp(shippedBytes) === a, true, 'js/data/lots.js 与烘焙产物不同（发货的文件过期了）');
});

test('bake: 烘焙打印的零计数，本套件独立再量一遍', () => {
  const grid = table(BOOK_BOUND);
  const c = retroCensus(BOOK_BOUND, { grid, crossCheck: true });
  eq(c.positions, 1830, '60·61/2');
  eq([c.win, c.loss], [1161, 669], '(bake) 1161 win / 669 loss');
  eq(c.win + c.loss, c.positions);
  eq(c.disagreements, 0, 'bottom-up 与记忆化递归必须逐格同意');
  eq(c.multiWinning, 0, 'Theorem B：胜口唯一');
  eq(c.noWinning, c.loss, '判胜必数得出胜口，判负必数不出');
  eq(c.lossWithChoice, 0, 'Theorem A：必败局只有一口');
  eq(c.marginZero, 0, 'a² = ab + b² 对正整数不可能');
  eq(c.squares, 60, 'a == b 的正方形每档一个，共 60 个');
  eq(c.maxDepth, 8, '(bake) 棋书最深帕 8');
  eq(c.argmax.length, 17, '(bake) 帕 8 的局面有 17 个');
  eq(c.widestChoice, 60, '1≤b≤a≤60 里最宽的选择是 60×1');
});

test('bake: φ 判据的结构检查自己就是干净的（reconcile 报 0）', () => {
  const rec = reconcile(BOOK_BOUND);
  eq(rec.positions, 1830);
  eq(rec.problems, []);
  eq([rec.wins, rec.losses], [1161, 669], '两条路线连计数都要一样');
});

test('bake: 两条路线逐格同意 —— 判定、胜口集合、帕，1830 格零分歧', () => {
  const grid = table(BOOK_BOUND);
  let diff = 0;
  for (const node of grid.values()) {
    const value = gIsLoss(node.a, node.b) ? 'loss' : 'win';
    const same = value === node.value
      && JSON.stringify(winningMoves(node.a, node.b)) === JSON.stringify(node.winning)
      && gDepth(node.a, node.b) === node.depth
      && cfLength(node.a, node.b) + slowSteps(node.a, node.b) === node.depth;
    if (!same) diff++;
  }
  eq(diff, 0);
});

test('bake: 三条长度恒等式在棋格上逐格成立（文档里的每一句都指到这里）', () => {
  const grid = table(BOOK_BOUND);
  let depthBad = 0;
  let sizeBad = 0;
  let countBad = 0;
  let insertionExamples = 0;
  for (let a = 1; a <= BOOK_BOUND; a++) {
    for (let b = 1; b <= a; b++) {
      const node = grid.get(pairKey(a, b));
      const qs = cfQuotients(a, b);
      if (node.depth !== qs.length + slowSteps(a, b)) depthBad++;
      const line = lineThrough(a, b);
      if (new Set(line.map((p) => p.b)).size !== qs.length) sizeBad++;
      if (line.reduce((s, p) => s + p.k, 0) !== squareCount(a, b)) countBad++;
      if (node.depth !== qs.length) insertionExamples++;
    }
  }
  eq([depthBad, sizeBad, countBad], [0, 0, 0]);
  // (bake) "positions where plies != divisions 961/1830" —— 「帕 == 除法数」在这张网格上错 961 次
  eq(insertionExamples, 961);
  eq(1830 - insertionExamples, 869);
});

test('bake: 那个反例本身（帕 3 / 除法 2）就在发货的棋书里', () => {
  eq([solve(7, 3).depth, cfLength(7, 3)], [3, 2]);
  eq([solve(5, 2).depth, cfLength(5, 2)], [3, 2]);
  eq([solve(12, 5).depth, cfLength(12, 5)], [5, 3]);
  // and the pure case: consecutive Fibonacci pairs have zero insertions
  for (const [a, b] of [[2, 1], [3, 2], [5, 3], [8, 5], [13, 8], [21, 13], [34, 21]]) {
    eq(slowSteps(a, b), 0, `${a}:${b} 不该有插入`);
    eq(solve(a, b).depth, cfLength(a, b), `${a}:${b} 梯子上的帕 == 除法数`);
    eq(Math.abs(margin(a, b)), 1);
  }
});

test('bake: 唯一胜口普查 1<=b<a<=300 —— 44850 对，违例 0', () => {
  // hand-derived count: Σ_{a=1..300}(a-1) = 299·300/2 = 44850
  let pairs = 0;
  let violations = 0;
  for (let a = 1; a <= 300; a++) {
    for (let b = 1; b < a; b++) {
      pairs++;
      if (winningMoves(a, b).length > 1) violations++;
    }
  }
  eq(pairs, 44850);
  eq(violations, 0);
});

test('bake: φ 普查在更大范围也逐对同意（这里跑 200，bake 默认跑到 1200）', () => {
  const small = phiCensus(200, { solve });
  eq(small.pairs, 20100, '200·201/2');
  eq(small.disagreements, 0);
  eq(small.agree, 20100);
  const big = phiCensus(BOOK_BOUND, { solve });
  eq([big.pairs, big.disagreements], [1830, 0]);
});

test('bake: Lamé 量出来就是 Fibonacci —— 需要 n 次除法的最短长边是 F(n+2)', () => {
  const F = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
  for (let n = 1; n <= 9; n++) {
    let best = null;
    for (let a = 2; a <= 200; a++) {
      for (let b = 1; b < a; b++) {
        if (cfLength(a, b) !== n) continue;
        if (!best || a < best.a || (a === best.a && b < best.b)) best = { a, b };
      }
    }
    eq([best.a, best.b], [F[n + 1], F[n]], `n=${n}`);
    eq(cfLength(best.a, best.b), n);
  }
});

test('bake: 每个档位的候选数就是它那段普查（题池不是抽出来的）', () => {
  // hand-derived: Σ_{a=A..B}(a-1)
  eq(candidates(BANDS[0]).length, 91);
  eq(candidates(BANDS[1]).length, 140);
  eq(candidates(BANDS[2]).length, 330);
  eq(candidates(BANDS[3]).length, 1209);
  eq(BANDS.length, 4);
});

test('bake: 棋书行序稳定（首行 1:1、末行 60:60），否则逐字节比较毫无意义', () => {
  const book = encodeBook(table(BOOK_BOUND));
  eq(book.rows[0], '1:1:win/1/1');
  eq(book.rows[book.rows.length - 1], '60:60:win/1/1');
  eq(book.states, 1830);
  const again = encodeBook(table(BOOK_BOUND));
  eq(again.rows.join('|'), book.rows.join('|'), '同一份表编了两次，顺序不同');
});

test('bake: 收尾 —— 恢复后的 js/data/lots.js 与进来时字节相同', () => {
  eq(Buffer.compare(readFileSync(lotsPath), shippedBytes), 0, '这个套件把发货文件弄坏了');
});

await run();
