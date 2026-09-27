// Route 1 — exhaustive retrograde analysis. Checked three ways: against the hand-derived fixture
// table, against a bottom-up table built by different control flow, and against a third no-memo
// walker (test/naive.mjs) that re-expands the game tree from scratch.

import { test, run, eq, ok } from '../tools/harness.mjs';
import { legalMoves, pairKey, quotient, successor } from '../js/core/euclid.js';
import { census, lineThrough, resetMemo, solve, solveKey, table } from '../js/core/retro.js';
import { isLoss as phiLoss, winningK as phiK } from '../js/core/golden.js';
import { FIB_LADDER, FIXTURES, LAME } from './fixture.mjs';
import { naiveMaxSide, naiveSolve } from './naive.mjs';

const grid60 = table(60);

test('retro: 每个 fixture 行的判定/帕/胜口/口数都对上', () => {
  for (const f of FIXTURES) {
    const s = solve(f.a, f.b);
    eq(s.value, f.v, `solve(${f.a},${f.b}).value`);
    eq(s.depth, f.d, `solve(${f.a},${f.b}).depth`);
    eq(s.legal, f.legal, `solve(${f.a},${f.b}).legal`);
    eq(s.winning, f.w, `solve(${f.a},${f.b}).winning`);
    eq(f.v === 'win' ? s.kStar : s.moves[0], f.k, `solve(${f.a},${f.b}) 的完美着法`);
  }
});

test('retro: Fibonacci 梯子每一级都在 table 与 solve 之间一致', () => {
  for (const f of FIB_LADDER) {
    const s = solve(f.a, f.b);
    const g = f.a <= 60 ? grid60.get(pairKey(f.a, f.b)) : null;
    eq(s.value, f.v, `solve(${f.a},${f.b})`);
    eq(s.depth, f.d, `solve(${f.a},${f.b}).depth`);
    if (g) {
      eq(g.value, f.v, `table ${f.a}:${f.b} value`);
      eq(g.depth, f.d, `table ${f.a}:${f.b} depth`);
    }
  }
});

test('retro: solve 与 table（同一模型的两条控制流）逐局面一致', () => {
  resetMemo();
  let checked = 0;
  for (const node of grid60.values()) {
    const s = solve(node.a, node.b);
    checked++;
    ok(s.value === node.value && s.depth === node.depth, `${node.key}: solve=${s.value}/${s.depth} table=${node.value}/${node.depth}`);
    eq(s.winning, node.winning, `${node.key} 胜口集合`);
    eq(node.kStar, node.winning.length ? node.winning[0] : null, `${node.key} kStar`);
  }
  eq(checked, 1830, '60 边界上的局面数');
});

test('retro: 必败局恰好一个合法口（Theorem A，穷举 1830 局）', () => {
  for (const node of grid60.values()) {
    if (node.value !== 'loss') continue;
    eq(node.legal, 1, `${node.key} 判负却有 ${node.legal} 个口`);
    eq(node.moves, [1], `${node.key} 的唯一口必须是 k=1`);
    ok(quotient(node.a, node.b) === 1, `${node.key} 的 q 不是 1`);
  }
});

test('retro: 必胜局恰好一个胜口（Theorem B，穷举 1830 局）', () => {
  let wins = 0;
  for (const node of grid60.values()) {
    if (node.value !== 'win') continue;
    wins++;
    eq(node.winning.length, 1, `${node.key} 有 ${node.winning.length} 个胜口`);
    const k = node.winning[0];
    ok(k === quotient(node.a, node.b) || k === quotient(node.a, node.b) - 1,
      `${node.key} 的胜口 ${k} 不在 {q-1,q}（q=${quotient(node.a, node.b)}）`);
  }
  eq(wins, 1161);
});

test('retro: 胜口交给对手的一定是必败局，帕正好差 1', () => {
  for (const node of grid60.values()) {
    const k = node.value === 'win' ? node.winning[0] : node.moves[0];
    const next = successor(node.a, node.b, k);
    if (next === null) {
      eq(node.depth, 1, `${node.key} 一步铺满却帕 ${node.depth}`);
      eq(node.value, 'win', `${node.key} 铺满了还判负`);
      eq(k, quotient(node.a, node.b), `${node.key} 铺满却没切到尽头`);
      continue;
    }
    const child = grid60.get(pairKey(next[0], next[1]));
    ok(child, `${node.key} 的后继不在网格里`);
    eq(child.depth + 1, node.depth, `${node.key} 与后继 ${child.key} 的帕差不为 1`);
    if (node.value === 'win') eq(child.value, 'loss', `${node.key} 的胜口交给了 ${child.value}`);
    else eq(child.value, 'win', `${node.key} 的强制后继不是胜局`);
  }
});

test('retro: 对手与提示读同一张表 —— 胜局里没有任何其他 k 能赢', () => {
  for (const node of grid60.values()) {
    if (node.value !== 'win') continue;
    for (const k of legalMoves(node.a, node.b)) {
      if (k === node.winning[0]) continue;
      const next = successor(node.a, node.b, k);
      const value = next === null ? 'win' : grid60.get(pairKey(next[0], next[1])).value;
      eq(value, 'win', `${node.key} 切 ${k} 竟然也赢（胜口不唯一）`);
    }
  }
});

test('retro: lineThrough 是一条真能走完的强制线', () => {
  for (const f of FIXTURES) {
    const line = lineThrough(f.a, f.b);
    eq(line.length, f.d, `${f.a}×${f.b} 的线路长度`);
    eq(line[0].a, f.a);
    eq(line[0].b, f.b);
    eq(line[line.length - 1].exact, true, `${f.a}×${f.b} 的线路没有以铺满结束`);
    line.forEach((p, i) => {
      eq(p.seat, i % 2 === 0 ? 'you' : 'ai', `${f.a}×${f.b} 第 ${i} 手的座位`);
      eq(p.k >= 1 && p.k <= p.quotient, true, `${f.a}×${f.b} 第 ${i} 手非法`);
    });
    // 交替座位 + 最后一手属于赢家：帕为奇数时先手收满，偶数时后手
    eq(line[line.length - 1].seat, f.d % 2 === 1 ? 'you' : 'ai', `${f.a}×${f.b} 的收官座位`);
  }
});

test('retro: 帕的奇偶决定谁收满 —— 先手必胜局一律是奇数帕', () => {
  for (const node of grid60.values()) {
    const parityOddMeansFirstWins = node.depth % 2 === 1;
    eq(parityOddMeansFirstWins, node.value === 'win', `${node.key}: 帕 ${node.depth} 却判 ${node.value}`);
  }
});

test('retro: 第三条实现（无 memo 的裸递归）在能穷举的范围内逐局同意', () => {
  const reached = naiveMaxSide(64, 300000);
  ok(reached >= 15, `裸递归只能穷举到 a=${reached}，太小了`);
  let checked = 0;
  let nodes = 0;
  for (let a = 1; a <= reached; a++) {
    for (let b = 1; b <= a; b++) {
      const n = naiveSolve(a, b, { budget: 300000 });
      const t = grid60.get(pairKey(a, b));
      checked++;
      nodes += n.nodes;
      ok(n.value === t.value && n.depth === t.depth,
        `${pairKey(a, b)}: naive=${n.value}/${n.depth} table=${t.value}/${t.depth}`);
      eq(n.winning, t.winning, `${pairKey(a, b)} 的胜口集合`);
    }
  }
  eq(checked, (reached * (reached + 1)) / 2);
  ok(nodes > 0);
});

test('retro: 裸递归与 φ 判据也同意（两条不相关的路线对上第三种答案）', () => {
  for (let a = 1; a <= 15; a++) {
    for (let b = 1; b <= a; b++) {
      const n = naiveSolve(a, b, { budget: 300000 });
      eq(n.value === 'loss', phiLoss(a, b), `${pairKey(a, b)} 的 naive/φ 判定不同`);
      if (n.value === 'win') eq(n.winning[0], phiK(a, b), `${pairKey(a, b)} 的 naive/φ 胜口不同`);
    }
  }
});

test('retro: census 在 60 边界上的每个计数都是量出来的', () => {
  const c = census(60, { grid: grid60, crossCheck: true });
  eq(c.maxA, 60);
  eq(c.positions, 1830);
  eq(c.win, 1161);
  eq(c.loss, 669);
  eq(c.squares, 60);
  eq(c.disagreements, 0, '自底向上与递归不一致');
  eq(c.multiWinning, 0, '出现两个胜口 —— 胜利不再唯一');
  eq(c.noWinning, c.loss);
  eq(c.lossWithChoice, 0, '必败局竟然有选择 —— Theorem A 被推翻');
  eq(c.marginZero, 0, 'φ 被判成有理数');
  eq(c.widestChoice, 60, '最宽的口数应该是 60×1');
  eq(c.maxDepth, 8);
  eq(c.depthHist[1] > 0 && c.depthHist[8] > 0, true);
  eq(Object.values(c.depthHist).reduce((x, y) => x + y, 0), 1830);
});

test('retro: census 的极深局都是 q=1 的必败局 —— 可下出来的最深胜局是帕 7', () => {
  const deep = [...grid60.values()].filter((n) => n.depth === 8);
  eq(deep.length, 17);
  for (const n of deep) {
    eq(n.value, 'loss', `${n.key} 帕 8 却不是必败局`);
    eq(n.legal, 1, `${n.key} 帕 8 却有 ${n.legal} 个口`);
  }
  let best = 0;
  for (const n of grid60.values()) if (n.value === 'win' && n.depth > best) best = n.depth;
  eq(best, 7);
});

test('retro: Lamé —— 需要 n 次除法的最短长边是 F(n+2)，取在 (F(n+2),F(n+1))', () => {
  for (const l of LAME) {
    const need = (a, b) => {
      let x = a;
      let y = b;
      let n = 0;
      while (y > 0) {
        n++;
        const t = x % y;
        x = y;
        y = t;
      }
      return n;
    };
    eq(need(l.a, l.b), l.n, `${l.a}×${l.b} 的除法数不是 ${l.n}`);
    let smaller = null;
    for (let a = 2; a < l.a; a++) {
      for (let b = 1; b < a; b++) if (need(a, b) >= l.n) smaller = `${a}:${b}`;
    }
    eq(smaller, null, `长边 ${l.a} 之前就有需要 ${l.n} 次除法的局：${smaller}`);
  }
});

test('retro: table 拒绝非法边界，solveKey 与 solve 同源', () => {
  let msg = null;
  try { table(0); } catch (e) { msg = e.message; }
  eq(msg, 'table: maxA 需要正整数');
  try { table(2.5); } catch (e) { msg = e.message; }
  eq(msg, 'table: maxA 需要正整数');
  eq(solveKey('29:12').depth, solve(29, 12).depth);
  eq(solveKey('29:12').value, 'win');
});

test('retro: 网格封闭性被 table 自己证明（它从不索引到自己之外）', () => {
  const g = table(24);
  eq(g.size, 300);
  for (const node of g.values()) {
    for (const k of node.moves) {
      const next = successor(node.a, node.b, k);
      if (next === null) continue;
      ok(g.has(pairKey(next[0], next[1])), `${node.key} 的后继不在 24 边界网格里`);
    }
  }
});

await run();
