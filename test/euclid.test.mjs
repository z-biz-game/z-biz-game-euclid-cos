// The rule model: the arithmetic the whole repo is played on. Every expectation here is written
// from the derivation in the comment above it (or from test/fixture.mjs, which is itself
// hand-derived), never from what the function returned when I ran it.

import { test, run, eq, ok, fail } from '../tools/harness.mjs';
import {
  MAX_EXACT_SIDE, area, cfLength, cfQuotients, checkPair, cutsExactly, cutBlocks, fib, gcd,
  isLegalMove, isPair, isSquare, legalMoves, margin, moveReason, normalise, pairKey, parsePairKey,
  quotient, ratioText, remainder, squareCount, successor, validatePair,
} from '../js/core/euclid.js';
import { FIB_LADDER, FIXTURES } from './fixture.mjs';

const rowOf = (a, b) => FIXTURES.find((f) => f.a === a && f.b === b);

test('euclid: MAX_EXACT_SIDE 是整数判据的准确上限（3a² 仍 < 2^53-1）', () => {
  eq(MAX_EXACT_SIDE, 54_794_158);
  // hand: 54_794_158² = 3_002_399_735_742_964 ; x3 = 9_007_199_207_228_892 < 9_007_199_254_740_991
  eq(MAX_EXACT_SIDE * MAX_EXACT_SIDE * 3 < Number.MAX_SAFE_INTEGER, true);
  eq((MAX_EXACT_SIDE + 1) * (MAX_EXACT_SIDE + 1) * 3 > Number.MAX_SAFE_INTEGER, true);
});

test('euclid: validatePair 拒掉非整数、非正、越界、非数字', () => {
  eq(validatePair(5, 3), null);
  eq(validatePair(5.5, 3), '边长 5.5×3 不是整数');
  eq(validatePair(0, 3), '边长必须为正（收到 0×3）');
  eq(validatePair(3, -1), '边长必须为正（收到 3×-1）');
  eq(validatePair(MAX_EXACT_SIDE + 1, 2), `边长超出整数判据的安全上限 ${MAX_EXACT_SIDE}`);
  eq(validatePair('5', 3), '边长必须是数字');
  eq(validatePair(NaN, 1), '边长 NaN×1 不是整数');
});

test('euclid: normalise/checkPair 把 (3,5) 折成 [5,3] 且不改入参', () => {
  eq(normalise(3, 5), [5, 3]);
  eq(normalise(4, 4), [4, 4]);
  eq(checkPair(11, 4), [11, 4]);
  let threw = null;
  try { normalise(2, 0); } catch (e) { threw = e.constructor.name + ':' + e.message; }
  eq(threw, 'RangeError:normalise: 边长必须为正（收到 2×0）');
});

test('euclid: pairKey/parsePairKey 互逆，且 key 总是长边在前', () => {
  eq(pairKey(3, 7), '7:3');
  eq(pairKey(7, 3), '7:3');
  eq(parsePairKey('7:3'), [7, 3]);
  for (const f of FIXTURES) eq(parsePairKey(pairKey(f.a, f.b)), [f.a, f.b]);
  let threw = null;
  try { parsePairKey('3-2'); } catch (e) { threw = e.constructor.name; }
  eq(threw, 'TypeError');
});

test('euclid: isPair 只承认 a >= b 的合法局面', () => {
  eq(isPair(5, 5), true);
  eq(isPair(5, 2), true);
  eq(isPair(2, 5), false);
  eq(isPair(4, 0), false);
  eq(isPair(4.5, 1), false);
});

test('euclid: quotient/remainder 是原样带余除法（不归一），area 是长×宽', () => {
  eq([quotient(13, 5), remainder(13, 5)], [2, 3]);
  eq([quotient(5, 5), remainder(5, 5)], [1, 0]);
  // 故意记录下来的边界：这两个函数按参数原样算，所以 (4,7) 得到 0。
  // legalMoves/moveReason/successor 都先过 checkPair，任何直接调 quotient 的调用方也一样 ——
  // 忘了归一就会造出「0 个合法口」的局面，而这是本仓最不该静默发生的事。
  eq([quotient(4, 7), remainder(4, 7)], [0, 4]);
  eq(quotient(...checkPair(4, 7)), 1);
  eq(area(13, 8), 104);
});

test('euclid: legalMoves = 1..floor(a/b)，一个不多一个不少', () => {
  eq(legalMoves(6, 1), [1, 2, 3, 4, 5, 6]);
  eq(legalMoves(13, 8), [1]);
  eq(legalMoves(1, 1), [1]);
  eq(legalMoves(4, 7), [1]); // 归一为 7×4 之后再算：q = floor(7/4) = 1
  for (const f of FIXTURES) {
    eq(legalMoves(f.a, f.b).length, f.legal, `legal(${f.a},${f.b})`);
  }
});

test('euclid: moveReason 是唯一的非法理由来源，非法永不静默', () => {
  eq(moveReason(13, 8, 1), null);
  eq(moveReason(13, 8, 2), '最多只能切 1 块（k=2 会把长边切负）');
  eq(moveReason(13, 8, 0), '至少要把一块方金切下来（k 必须 >= 1）');
  eq(moveReason(13, 8, -3), '至少要把一块方金切下来（k 必须 >= 1）');
  eq(moveReason(13, 8, 1.5), 'k 不是整数');
  eq(moveReason(13, 8, '1'), 'k 不是整数');
  eq(moveReason(13, 0, 1), '边长必须为正（收到 13×0）');
  eq(isLegalMove(13, 8, 1), true);
  eq(isLegalMove(13, 8, 2), false);
});

test('euclid: successor 换手归长边，铺满时返回 null', () => {
  eq(successor(13, 8, 1), [8, 5]);   // 13-8=5 < 8 → 长条转 90°
  eq(successor(11, 4, 1), [7, 4]);   // 11-4=7 > 4 → 不转
  eq(successor(11, 4, 2), [4, 3]);
  eq(successor(12, 4, 3), null);     // 12 = 3·4，铺满
  eq(successor(2, 1, 2), null);
  let threw = null;
  try { successor(5, 3, 2); } catch (e) { threw = e.message; }
  eq(threw, 'successor: 最多只能切 1 块（k=2 会把长边切负）');
});

test('euclid: 每一手都严格缩短长边（表格能自底向上填完的原因）', () => {
  for (const f of FIXTURES) {
    for (const k of legalMoves(f.a, f.b)) {
      const next = successor(f.a, f.b, k);
      if (next === null) continue;
      ok(next[0] < f.a, `${f.a}×${f.b} 切 ${k} 后长边没有变短`);
      ok(next[0] >= next[1] && next[1] >= 1, `${f.a}×${f.b} 切 ${k} 后不是合法局面`);
    }
  }
});

test('euclid: 局面集 {1<=b<=a<=N} 对走法封闭（后继永不在网格外）', () => {
  const N = 60;
  for (let a = 1; a <= N; a++) {
    for (let b = 1; b <= a; b++) {
      for (const k of legalMoves(a, b)) {
        const next = successor(a, b, k);
        if (next === null) continue;
        ok(next[0] <= N && next[1] >= 1, `${a}:${b} 切 ${k} 出了网格`);
      }
    }
  }
});

test('euclid: cutsExactly 只对 k = q 且 b | a 为真', () => {
  eq(cutsExactly(12, 4, 3), true);
  eq(cutsExactly(12, 4, 2), false);
  eq(cutsExactly(13, 4, 3), false); // 13-12=1，剩一条
  eq(cutsExactly(5, 5, 1), true);
  let threw = null;
  try { cutsExactly(12, 4, 9); } catch (e) { threw = e.message; }
  eq(threw, 'cutsExactly: 最多只能切 3 块（k=9 会把长边切负）');
});

test('euclid: cutBlocks 给出 k 块边长 b 的方块与剩余条宽', () => {
  eq(cutBlocks(13, 5, 2), { blocks: [{ x: 0, size: 5 }, { x: 5, size: 5 }], leftover: 3, side: 5 });
  eq(cutBlocks(12, 6, 2).leftover, 0);
  eq(cutBlocks(12, 6, 2).blocks.length, 2);
  eq(cutBlocks(7, 3, 1), { blocks: [{ x: 0, size: 3 }], leftover: 4, side: 3 });
  // 切掉的面积 = k·b²，剩余 = leftover·b：视图与账目必须同源
  const c = cutBlocks(29, 12, 2);
  eq(c.blocks.length * c.side * c.side + c.leftover * c.side, area(29, 12));
});

test('euclid: margin = a²-ab-b² 就是 φ 的整数影子', () => {
  for (const f of FIXTURES) eq(margin(f.a, f.b), f.m, `margin(${f.a},${f.b})`);
  eq(margin(3, 5), margin(5, 3)); // 归一化后同一局
  // hand: 平方数上 margin = -b² < 0 却必胜 —— 黄金带唯一的例外
  eq(margin(4, 4), -16);
  // margin = 0 需要 a/b = φ，正整数做不到：60 以内穷举为 0
  let zeros = 0;
  for (let a = 1; a <= 60; a++) for (let b = 1; b <= a; b++) if (margin(a, b) === 0) zeros++;
  eq(zeros, 0);
});

test('euclid: margin 的符号与整数比较 a² vs ab+b² 完全一致', () => {
  for (let a = 2; a <= 200; a++) {
    for (let b = 1; b < a; b++) {
      const m = margin(a, b);
      eq(m < 0, a * a < a * b + b * b, `${a}×${b}`);
      eq(m >= 0, a * a >= a * b + b * b, `${a}×${b}`);
    }
  }
});

test('euclid: isSquare 只认 a == b', () => {
  eq(isSquare(9, 9), true);
  eq(isSquare(9, 3), false);
  eq(isSquare(3, 9), false);
});

test('euclid: cfQuotients 是欧几里得链的部分商', () => {
  eq(cfQuotients(13, 8), [1, 1, 1, 1, 2]);
  eq(cfQuotients(5, 2), [2, 2]);
  eq(cfQuotients(12, 5), [2, 2, 2]); // 12=2·5+2, 5=2·2+1, 2=2·1
  eq(cfQuotients(6, 1), [6]);
  eq(cfQuotients(4, 4), [1]);
  eq(cfQuotients(1, 1), [1]);
  // 部分商之和 = 贪心平铺切出的方块总数
  // 29 = 2·12+5, 12 = 2·5+2, 5 = 2·2+1, 2 = 2·1 —— 四次除法，帕却是 7：三次「插入」
  eq(cfQuotients(29, 12), [2, 2, 2, 2]);
});

test('euclid: cfLength 与 fixture 的除法数一一对上', () => {
  for (const f of FIXTURES) eq(cfLength(f.a, f.b), f.cf, `cfLength(${f.a},${f.b})`);
  for (const f of FIB_LADDER) eq(cfLength(f.a, f.b), f.cf, `cfLength(${f.a},${f.b})`);
});

test('euclid: squareCount = Σ 部分商 = 完美对局切下的方块总数', () => {
  eq(squareCount(5, 2), 4);   // [2,2]
  eq(squareCount(13, 8), 6);  // [1,1,1,1,2]
  eq(squareCount(6, 1), 6);
  eq(squareCount(12, 5), 6);  // [2,2,2]
  eq(squareCount(1, 1), 1);
  // 恒等式：a×b 的金条被这些方块正好铺满 —— Σ q_i · s_i² = a·b（见 test/anchor）
  const check = (a, b) => {
    let x = a;
    let y = b;
    let sum = 0;
    while (y > 0) {
      const q = Math.floor(x / y);
      sum += q * y * y;
      const t = x % y;
      x = y;
      y = t;
    }
    return sum;
  };
  for (const f of FIXTURES) eq(check(f.a, f.b), area(f.a, f.b), `${f.a}×${f.b} 平铺面积不闭合`);
});

test('euclid: ratioText 用整数长除给出 a/b，永不让浮点靠近判定', () => {
  eq(ratioText(13, 8), '1.6250');
  eq(ratioText(5, 2), '2.5000');
  eq(ratioText(34, 21), '1.6190'); // 34/21 = 1.6190476…
  eq(ratioText(21, 13), '1.6153'); // 21/13 = 1.6153846…（一个在 φ 上、一个在 φ 下）
  eq(ratioText(6, 1), '6.0000');
  eq(ratioText(1, 1, 0), '1');
  eq(ratioText(2, 1, 2), '2.00');
});

test('euclid: gcd 与 fib 的 literals', () => {
  eq(gcd(12, 8), 4);
  eq(gcd(13, 8), 1);
  eq(gcd(7, 7), 7);
  eq(gcd(1, 1), 1);
  eq([fib(1), fib(2), fib(3), fib(4), fib(10), fib(14)], [1, 1, 2, 3, 55, 377]);
  let threw = null;
  try { fib(0); } catch (e) { threw = e.message; }
  eq(threw, 'fib: 需要正整数下标');
});

test('euclid: fib 与 FIB_LADDER 的每一行自洽（F(n+1),F(n)）', () => {
  for (const f of FIB_LADDER) {
    eq([fib(f.n + 1), fib(f.n)], [f.a, f.b], `fib(${f.n})`);
    eq(margin(f.a, f.b), f.m, `margin(F${f.n + 1},F${f.n})`);
    ok(Math.abs(f.m) === 1, `${f.a}×${f.b} 的 margin 不是 ±1`);
  }
});

test('euclid: 非法入参一律抛出而不是返回 undefined', () => {
  const boom = (fn, args) => {
    try {
      fn(...args);
      return 'no-throw';
    } catch (e) {
      return e.constructor.name;
    }
  };
  eq(boom(legalMoves, [3, 0]), 'RangeError');
  eq(boom(margin, [0, 0]), 'RangeError');
  eq(boom(squareCount, [1.5, 1]), 'RangeError');
  eq(boom(cutBlocks, [5, 2, 99]), 'RangeError');
  eq(boom(pairKey, [5, -2]), 'RangeError');
});

test('euclid: fixture 表内部自洽（每一行的 legal/why/w 与规则同源）', () => {
  for (const f of FIXTURES) {
    eq(f.a >= f.b, true, `${f.a}×${f.b} 未归一化`);
    eq(quotient(f.a, f.b), f.q, `${f.a}×${f.b} q`);
    eq(f.w.length, f.v === 'win' ? 1 : 0, `${f.a}×${f.b} 胜口个数应恰为 ${f.v === 'win' ? 1 : 0}`);
    eq(f.v === 'win' ? f.w[0] : f.k, f.k, `${f.a}×${f.b} 的 k`);
    eq(f.d - f.cf, f.ins, `${f.a}×${f.b} 的 ins`);
    if (f.v === 'loss') eq(f.q, 1, `必败局 ${f.a}×${f.b} 竟然有 ${f.q} 个口（Theorem A）`);
    if (f.v === 'win' && f.q > 1) ok(f.w[0] === f.q || f.w[0] === f.q - 1, `${f.a}×${f.b} 的胜口不在 {q-1,q}`);
  }
  ok(FIXTURES.length >= 20, 'fixture 行数不足');
});

test('euclid: 三条民俗在手里就已经是假的（本仓不发未证的说法）', () => {
  // 1) 「手数 == 除法数」：(7,3) 帕 3 而除法 2 次
  const seven = rowOf(7, 3);
  eq([seven.d, seven.cf], [3, 2]);
  // 2) 「胜口判据对所有 k 一致」：(5,2) 的 k=2 剩 1 → (2,1) 是对手的胜局
  eq(successor(5, 2, 2), [2, 1]);
  eq(margin(2, 1) < 0, false); // (2,1) 不是必败局，所以 k=2 不是胜口
  eq(rowOf(5, 2).w, [1]);
  // 3) 「上限内最深的局是 Fibonacci 对」：见 test/anchor.test.mjs 的穷举普查
  ok(true);
});

await run();
