// Route 2 — the φ predicate, checked three ways: against the hand-derived fixture table, against
// route 1 over the shipped grid, and against route 1 over a range the shipped book has never
// covered (1 <= b <= a <= 1200 = 720_600 pairs). The measured counts are PRINTED, because in this
// repo a number in a document has to be a number some test already paid for.

import { test, run, eq, ok } from '../tools/harness.mjs';
import { cfLength, legalMoves, margin, pairKey, quotient, successor } from '../js/core/euclid.js';
import { solve, table } from '../js/core/retro.js';
import {
  census as phiSweep, depth as phiDepth, isLoss, isWin, lineThrough, reconcile, slowSteps,
  winningK, winningMoves,
} from '../js/core/golden.js';
import { FIB_LADDER, FIXTURES } from './fixture.mjs';

test('golden: 判定就是 a² 与 ab+b² 的整数比较，逐行对上 fixture', () => {
  for (const f of FIXTURES) {
    eq(isLoss(f.a, f.b), f.v === 'loss', `isLoss(${f.a},${f.b})`);
    eq(isWin(f.a, f.b), f.v === 'win', `isWin(${f.a},${f.b})`);
    eq(margin(f.a, f.b), f.m, `margin(${f.a},${f.b})`);
    if (f.a > f.b) eq(f.m < 0, f.a * f.a < f.a * f.b + f.b * f.b, `${f.a}×${f.b} 的整数比较`);
  }
  // 手推的两个临界：1×1 是带外唯一的例外，(3,2) 是带内最小的必败
  eq(isLoss(1, 1), false);
  eq(isLoss(3, 2), true);
  eq(isLoss(5, 3), false); // 5/3 = 1.666… 在 φ 之上
});

test('golden: 判据里没有浮点数（同一条不等式用长乘再算一遍，1<=b<=a<=200）', () => {
  let losses = 0;
  let viaSearch = 0;
  for (let a = 1; a <= 200; a++) {
    for (let b = 1; b <= a; b++) {
      const bySign = a > b ? margin(a, b) < 0 : false;
      const byMultiply = a > b ? a * a < a * b + b * b : false;
      eq(isLoss(a, b), bySign, `${pairKey(a, b)} margin 路线`);
      eq(bySign, byMultiply, `${pairKey(a, b)} 整数路线`);
      if (bySign) losses++;
      if (solve(a, b).value === 'loss') viaSearch++;
      if (bySign) {
        eq(quotient(a, b), 1, `${pairKey(a, b)} 判负却切得动两口（Theorem A）`);
        eq(winningK(a, b), null, `${pairKey(a, b)} 判负却有胜口`);
        ok(successor(a, b, 1) !== null, `${pairKey(a, b)} 一口就铺满了还判负`);
      }
    }
  }
  eq(viaSearch, losses, 'φ 判据与穷举递归在 a<=200 上分歧');
  console.log(`       [measured] 1<=b<=a<=200 共 ${(200 * 201) / 2} 局，两路同判必败 ${losses} 局`);
});

test('golden: 浮点 φ 与整数判据落在同一侧（只在核对时用一次 sqrt）', () => {
  const phi = (1 + Math.sqrt(5)) / 2;
  for (let a = 2; a <= 60; a++) {
    for (let b = 1; b < a; b++) {
      eq(a / b < phi, margin(a, b) < 0, `${a}/${b}`);
    }
  }
});

test('golden: 胜口由 φ 推出，与 fixture 的唯一胜口一致', () => {
  for (const f of FIXTURES) {
    eq(winningK(f.a, f.b), f.v === 'win' ? f.k : null, `winningK(${f.a},${f.b})`);
    eq(winningMoves(f.a, f.b), f.w, `winningMoves(${f.a},${f.b})`);
  }
  // 手推：(29,12) q=2。k=2 交给 (12,5)（胜），k=1 交给 (17,12)（负）⇒ 胜口 1
  eq(successor(29, 12, 1), [17, 12]);
  eq(isLoss(17, 12), true);
  eq(isLoss(12, 5), false);
  eq(winningK(29, 12), 1);
});

test('golden: 胜口只落在 {q-1, q}，整除局只有 k=q 赢', () => {
  for (const node of table(60).values()) {
    if (node.value !== 'win') continue;
    const q = quotient(node.a, node.b);
    eq(winningK(node.a, node.b), node.winning[0], `${node.key} 两条路线的胜口不同`);
    ok(node.winning[0] === q || node.winning[0] === q - 1, `${node.key} 胜口 ${node.winning[0]} 不在 {q-1,q}`);
    if (node.a % node.b === 0) eq(node.winning[0], q, `${node.key} 整除局却没切到尽头`);
  }
  for (let b = 1; b <= 20; b++) {
    for (let m = 1; m <= 6; m++) {
      const a = m * b;
      eq(winningMoves(a, b), [m], `${a}:${b} 的胜口集合`);
      for (let k = 1; k < m; k++) {
        const next = successor(a, b, k);
        eq(isWin(next[0], next[1]), true, `${a}:${b} 切 ${k} 之后对手竟然必败`);
      }
    }
  }
});

test('golden: 帕 = 除法数 + 插入数（手推的三个例子 + 全网格恒等式）', () => {
  // 手推 (29,12)：链 [2,2,2,2] 四次除法；(12,5)、(5,2)、(2,1) 三个后继都判胜 ⇒ 三次插入 ⇒ 帕 7
  eq(cfLength(29, 12), 4);
  eq(slowSteps(29, 12), 3);
  eq(phiDepth(29, 12), 7);
  eq(solve(29, 12).depth, 7);
  // 手推 (12,5)：链 [2,2,2]，插入两次 ⇒ 帕 5
  eq([cfLength(12, 5), slowSteps(12, 5), phiDepth(12, 5)], [3, 2, 5]);
  // 手推 (7,3)：链 [2,3]，一次插入 ⇒ 帕 3（这条否定了「帕 == 除法数」）
  eq([cfLength(7, 3), slowSteps(7, 3), phiDepth(7, 3)], [2, 1, 3]);
  for (const f of FIB_LADDER) eq(slowSteps(f.a, f.b), 0, `slowSteps(${f.a},${f.b})`);
  for (const node of table(60).values()) {
    eq(node.depth, cfLength(node.a, node.b) + slowSteps(node.a, node.b), `${node.key}`);
    eq(node.depth, phiDepth(node.a, node.b), `${node.key} 的 φ 帕不同`);
  }
});

test('golden: 强制线由 φ 单独重建，长度就是帕，并且以铺满收尾', () => {
  for (const f of FIXTURES) {
    const line = lineThrough(f.a, f.b);
    eq(line.length, f.d, `${f.a}×${f.b} 的线路长度 != fixture 帕`);
    eq(line.length, phiDepth(f.a, f.b), `${f.a}×${f.b} 的线路 != 帕`);
    eq(line[line.length - 1].exact, true, `${f.a}×${f.b} 的线路没有以铺满结束`);
    eq(line.every((p, i) => p.seat === (i % 2 === 0 ? 'you' : 'ai')), true);
    eq(line[0].k, f.k, `${f.a}×${f.b} 的第一手`);
  }
});

test('golden: reconcile 在 60 边界上报 0 个问题，计数就是三角数', () => {
  const r = reconcile(60);
  eq(r.maxA, 60);
  eq(r.positions, 1830);
  eq(r.positions, (60 * 61) / 2);
  eq(r.wins + r.losses, r.positions);
  eq(r.wins, 1161);
  eq(r.losses, 669);
  eq(r.problems, []);
});

test('golden: 唯一胜口普查 1<=b<a<=300（44850 对）—— 违例 0', () => {
  let pairs = 0;
  const violations = [];
  let lossWithChoice = 0;
  let zeroMargin = 0;
  for (let a = 2; a <= 300; a++) {
    for (let b = 1; b < a; b++) {
      pairs++;
      const wm = winningMoves(a, b);
      const lost = isLoss(a, b);
      if (wm.length > 1) violations.push(`${pairKey(a, b)}: ${wm.join(',')}`);
      if (lost && wm.length !== 0) violations.push(`${pairKey(a, b)}: 判负却有胜口`);
      if (!lost && wm.length !== 1) violations.push(`${pairKey(a, b)}: 判胜却有 ${wm.length} 个胜口`);
      if (lost && legalMoves(a, b).length !== 1) lossWithChoice++;
      if (margin(a, b) === 0) zeroMargin++;
    }
  }
  eq(pairs, 44850);
  eq(violations, []);
  eq(lossWithChoice, 0, '必败局竟然有选择 —— Theorem A 被推翻');
  eq(zeroMargin, 0, '有整数对把 a/b 判成 φ');
  console.log(`       [measured] 唯一胜口普查 ${pairs} 对：违例 0、margin=0 0 个、必败有选择 0 个`);
});

test('golden: 两条路线在 1<=b<=a<=1200 = 720600 对上逐对同意', () => {
  const c = phiSweep(1200, { solve });
  eq(c.maxA, 1200);
  eq(c.pairs, 720600);
  eq(c.agree, 720600);
  eq(c.disagreements, 0);
  eq(c.disagree, []);
  console.log(`       [measured] φ 普查：${c.pairs} 对，同意 ${c.agree}，分歧 ${c.disagreements}`);
});

test('golden: census 拒绝在没有 route 1 时被调用（它不可能自证）', () => {
  let msg = null;
  try { phiSweep(10, {}); } catch (e) { msg = e.message; }
  eq(msg, 'census 需要传入 route-1 的 solve，才能保持本文件零依赖 route-1');
});

test('golden: Fibonacci 梯子 —— |margin| = 1、判定交替、帕 = 除法数', () => {
  for (const f of FIB_LADDER) {
    eq(Math.abs(margin(f.a, f.b)), 1, `${f.a}×${f.b} 的 margin 不是 ±1`);
    eq(margin(f.a, f.b), f.m, `${f.a}×${f.b} 的 margin`);
    eq(isLoss(f.a, f.b), f.v === 'loss', `${f.a}×${f.b} 的判定`);
    eq(phiDepth(f.a, f.b), f.d, `${f.a}×${f.b} 的帕`);
    eq(cfLength(f.a, f.b), f.cf);
    eq(slowSteps(f.a, f.b), 0);
    eq(winningK(f.a, f.b), f.v === 'win' ? (f.a % f.b === 0 ? f.a / f.b : 1) : null, `${f.a}×${f.b} 的胜口`);
  }
  for (let i = 1; i < FIB_LADDER.length; i++) {
    eq(FIB_LADDER[i].v === 'win', FIB_LADDER[i - 1].v === 'loss', 'Fibonacci 判定没有交替');
  }
});

test('golden: 黄金带内的每一局都在 φ 之下（长乘核对，界外反例手推）', () => {
  for (const f of FIXTURES.filter((x) => x.v === 'loss')) {
    eq(f.a * f.a < f.a * f.b + f.b * f.b, true, `${f.a}/${f.b} 不在带内却判负`);
    eq(quotient(f.a, f.b), 1);
    ok(f.m < 0, `${f.a}×${f.b} 的 margin 不是负数`);
  }
  eq(5 * 5 < 5 * 3 + 3 * 3, false); // 25 > 24：(5,3) 在带外，先手胜
  eq(isLoss(5, 3), false);
  eq(8 * 8 < 8 * 5 + 5 * 5, true); // 64 < 65：(8,5) 在带内，先手负
  eq(isLoss(8, 5), true);
});

await run();
