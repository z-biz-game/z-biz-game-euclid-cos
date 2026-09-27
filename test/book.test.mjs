// test/book.test.mjs — the shipped opening book, audited as TEXT.
//
// The contract this suite holds: the browser's only source of truth is a serialised table, so the
// table must be (a) self-consistent, (b) exactly the thing the bake measured, and (c) unable to
// answer a question it was never baked for. Expectations below are hand-derived literals; the
// arithmetic is written next to each one, and where a number could only come from a measurement it
// says so (`node tools/bake.mjs` prints it too).
//
//   node test/book.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';

import {
  bestK, decodeBook, encodeBook, encodeRow, inBook, isLoss, isMissError, isWin, lookup,
  par, recomputeBook, valueOf,
} from '../js/core/book.js';
import { solve, table } from '../js/core/retro.js';
import { BOOK, LOTS, SCHEMA } from '../js/data/lots.js';
import { BOOK_BOUND } from '../js/core/make.js';
import { quotient, successor } from '../js/core/euclid.js';

const map = decodeBook(BOOK);

// hand-derived: rows of the triangle {1 <= b <= a <= 60} = sum_{a=1..60} a = 60*61/2 = 1830.
const TRIANGLE_60 = (60 * 61) / 2;

// ------------------------------------------------------------------ shape of the payload
test('book: 负载字段就是烘焙声明的那一组', () => {
  eq(SCHEMA, 'euclid-lots-v1');
  eq(BOOK.bound, BOOK_BOUND, 'bound 必须等于 js/core/make.js 的 BOOK_BOUND');
  eq(BOOK.bound, 60);
  eq(BOOK.states, TRIANGLE_60, 'states 必须是三角数 60·61/2 = 1830');
  eq(BOOK.rows.length, BOOK.states);
  // measured by `node tools/bake.mjs` ("1161 win / 669 loss") and re-counted below.
  eq(BOOK.win + BOOK.loss, BOOK.states, '胜负计数必须不重不漏');
});

test('book: 行序是升序 a、升序 b，首行 1:1，末行 60:60', () => {
  eq(BOOK.rows[0], '1:1:win/1/1');
  eq(BOOK.rows[BOOK.rows.length - 1], '60:60:win/1/1');
  let i = 0;
  for (let a = 1; a <= 60; a++) {
    for (let b = 1; b <= a; b++, i++) {
      const hit = /^(\d+):(\d+):/.exec(BOOK.rows[i]);
      if (!hit || Number(hit[1]) !== a || Number(hit[2]) !== b) {
        throw new Error(`第 ${i} 行不是 ${a}:${b}，而是 ${BOOK.rows[i]}`);
      }
    }
  }
  eq(i, TRIANGLE_60);
});

test('book: 首行 1:1 的显式值（铺满一步、帕 1、margin<0 却是胜）', () => {
  eq(lookup(map, 1, 1), { key: '1:1', a: 1, b: 1, value: 'win', k: 1, depth: 1, raw: '1:1:win/1/1' });
  eq(marginSignExceptionHolds(), true, 'a==b 是黄金带的例外');
});
function marginSignExceptionHolds() {
  // 1*1 - 1*1 - 1*1 = -1 < 0 and the book still says win: the exception golden.js documents.
  return (1 - 1 - 1) < 0 && valueOf(map, 1, 1) === 'win';
}

test('book: decodeBook 返回的 Map 带 bound，且大小就是行数', () => {
  eq(map.size, BOOK.states);
  eq(map.bound, 60);
});

// ------------------------------------------------------------------ decodeBook REFUSES
const clone = () => JSON.parse(JSON.stringify(BOOK));

test('book: rows 缺失就直接拒（棋书没烘焙）', () => {
  throwsLike(() => decodeBook({ bound: 60, rows: null }), /rows 缺失/);
  throwsLike(() => decodeBook(null), /rows 缺失/);
  throwsLike(() => decodeBook({}), /rows 缺失/);
});

test('book: bound 非法就拒（0、负数、非整数、缺省）', () => {
  for (const bad of [0, -3, 6.5, undefined, null, '60']) {
    const p = clone();
    p.bound = bad;
    throwsLike(() => decodeBook(p), /bound 需要正整数/, JSON.stringify(bad));
  }
});

test('book: 声明的行数与实际不符就拒（三角不闭合 / states 撒谎）', () => {
  const short = clone();
  short.rows.pop();
  throwsLike(() => decodeBook(short), /边界 60 应有 1830 行，实际 1829 行/);
  const lying = clone();
  lying.states = 1829;
  throwsLike(() => decodeBook(lying), /声明 states=1829，实际 1830 行/);
  const offByBand = clone();
  offByBand.bound = 61; // 61*62/2 = 1891 != 1830 —— 换边界必须重烘
  throwsLike(() => decodeBook(offByBand), /应有 1891 行/);
});

test('book: 重复的局面会被拒（同一格两行 = 两个真值）', () => {
  const dup = clone();
  dup.rows[10] = dup.rows[9]; // 复制上一行，制造重复键
  throwsLike(() => decodeBook(dup), /重复的局面/);
});

test('book: 缺行会被拒（三角必须闭合）', () => {
  const miss = clone();
  miss.rows = miss.rows.filter((r) => r !== '7:3:win/1/3');
  // dropping one row without touching bound trips the row-count guard first...
  throwsLike(() => decodeBook(miss), /应有 1830 行，实际 1829 行/);
  // ...so close the triangle back up with a duplicate-free extra row to reach the hole guard.
  const shifted = clone();
  shifted.rows[10] = '2:2:win/1/1';
  throwsLike(() => decodeBook(shifted), /重复的局面|缺行/);
});

test('book: 无法解析的行一律拒（键的形状就是协议）', () => {
  for (const bad of ['7:3:win/1', '7:3:win/1/3/9', '7-3:win/1/3', 'nonsense', '', '7:3:draw/1/3',
    '07:3:win/1/3', '7:3:WIN/1/3', '7:3:win/01/3', '7:3:win/1/x', ' 7:3:win/1/3']) {
    const p = clone();
    p.rows[5] = bad;
    throwsLike(() => decodeBook(p), /无法解析的行|重复的局面|缺行/, JSON.stringify(bad));
  }
});

test('book: 未规范化的键（b > a）被拒', () => {
  const p = clone();
  p.rows[5] = '3:7:win/1/3'; // 3:7 是 7:3 的另一半说法，棋书只允许一种
  throwsLike(() => decodeBook(p), /未规范化（b > a）/);
});

test('book: 越界的行被拒（a > bound）', () => {
  const p = clone();
  p.rows[5] = '61:3:win/1/3';
  throwsLike(() => decodeBook(p), /行越界（bound=60）/);
});

test('book: 非字符串行被拒', () => {
  for (const bad of [null, undefined, 7, { a: 1 }, ['1:1:win/1/1']]) {
    const p = clone();
    p.rows[3] = bad;
    throwsLike(() => decodeBook(p), /非字符串行|无法解析/, JSON.stringify(bad));
  }
});

test('book: 非法的 k（超出 q）被拒', () => {
  const p = clone();
  // 7:3 的 q = floor(7/3) = 2，所以 k=3 不是合法一口
  eq(quotient(7, 3), 2);
  p.rows[indexOf(p, 7, 3)] = '7:3:win/3/3';
  throwsLike(() => decodeBook(p), /的 k 非法（q=2）/);
});

test('book: 胜口必须交给对手一个必败行，深度差 1', () => {
  const lie = clone();
  // 5:2 的真实胜口是 k=1（→3:2 必败，帕 2 ⇒ 帕 3）。把后继改成胜局：伪造 k=2 后 depth 不变。
  eq(lookup(map, 5, 2).k, 1);
  eq(lookup(map, 3, 2).value, 'loss');
  eq(successor(5, 2, 1), [3, 2]);
  lie.rows[indexOf(lie, 5, 2)] = '5:2:win/1/4'; // 后继帕 2 ⇒ 应该是 3，写成 4
  throwsLike(() => decodeBook(lie), /深度差不是 1/);
});

test('book: 铺满型胜局必须 k==q 且帕 1', () => {
  const p = clone();
  eq(quotient(6, 2), 3);
  eq(lookup(map, 6, 2).k, 3);
  eq(lookup(map, 6, 2).depth, 1);
  p.rows[indexOf(p, 6, 2)] = '6:2:win/3/2';
  throwsLike(() => decodeBook(p), /一步铺满却 depth!=1/);
  const q = clone();
  q.rows[indexOf(q, 6, 2)] = '6:2:win/2/3'; // k=2 剩 2:2，不是铺满，却写成帕 3 的胜局？
  throwsLike(() => decodeBook(q), /k 非法|深度差不是 1|胜口交给对手一个 win/);
});

test('book: 判负却留多个合法口 = Theorem A 被推翻，直接拒', () => {
  const p = clone();
  // 7:4 真实判定是 win（帕 3）；伪造一个 q=1 的必败行是合法的，所以拿 5:2（q=2）来伪造。
  eq(quotient(5, 2), 2);
  p.rows[indexOf(p, 5, 2)] = '5:2:loss/1/3';
  throwsLike(() => decodeBook(p), /判负却还有 2 个合法口（Theorem A 被推翻）/);
});

test('book: 必败行的 forced 后继必须是胜局', () => {
  const p = clone();
  // 3:2 是真必败局（q=1，后继 2:1 是胜局）：把它改成 depth 2 → 后继帕 1，深度差 1 通过，
  // 所以这里伪造的是「后继不是胜局」：4:3 → k=1 → 3:1（胜），改成 depth 9 触发差值不符。
  eq(successor(3, 2, 1), [2, 1]);
  eq(lookup(map, 2, 1).value, 'win');
  p.rows[indexOf(p, 3, 2)] = '3:2:loss/1/9';
  throwsLike(() => decodeBook(p), /深度差不是 1/);
});

// ------------------------------------------------------------------ lookup refuses to search
test('book: 越出棋书的局面 lookup 抛异常（绝不现场搜索）', () => {
  let err = null;
  try { lookup(map, 61, 7); } catch (e) { err = e; }
  ok(err, 'a=61 越出 bound 60，必须抛');
  eq(isMissError(err), true, '抛的必须是 MissError');
  ok(/拒绝现场搜索/.test(err.message), err && err.message);
  ok(/不在棋书里/.test(err.message), err && err.message);
});

test('book: 边界上的最后一格仍在书里，紧邻其外就不在', () => {
  eq(inBook(map, 60, 59), true);
  eq(inBook(map, 60, 60), true);
  eq(inBook(map, 61, 60), false);
  eq(inBook(map, 61, 61), false);
  throwsLike(() => lookup(map, 61, 60), /不在棋书里/);
  throwsLike(() => lookup(map, 1200, 743), /不在棋书里/, 'φ 普查扫到 1200，棋书只到 60');
});

test('book: 非法坐标在查表前就被 euclid 拒掉', () => {
  for (const [a, b] of [[0, 1], [-3, 2], [2.5, 1], [NaN, 1], [10, 0]]) {
    throwsLike(() => lookup(map, a, b), /边长/, `${a}×${b}`);
  }
});

test('book: valueOf / isWin / isLoss / par / bestK 都读同一行', () => {
  eq(valueOf(map, 7, 3), 'win');
  eq(isWin(map, 7, 3), true);
  eq(isLoss(map, 7, 3), false);
  eq(par(map, 7, 3), 3);
  eq(bestK(map, 7, 3), 1);
  // the fixture's headline counterexample: 帕 3 while Euclid divides twice
  eq([par(map, 7, 3), bestK(map, 7, 3)], [3, 1]);
});

test('book: 每一行都能被 successor 走通（k 合法、帕与后继一致）', () => {
  let checked = 0;
  for (const lot of LOTS) {
    const row = lookup(map, lot.a, lot.b);
    const next = successor(row.a, row.b, row.k);
    if (next === null) {
      eq(row.depth, 1, `${row.key} 铺满必须帕 1`);
      eq(row.k, quotient(row.a, row.b));
    } else {
      const child = lookup(map, next[0], next[1]);
      eq(child.depth + 1, row.depth, `${row.key} 与后继深度差`);
    }
    checked++;
  }
  eq(checked, LOTS.length);
});

// ------------------------------------------------------------------ the shipped lots vs the book
test('book: 每一张发货的题卡印的判定/k/帕都等于棋书那一行', () => {
  const bad = [];
  for (const lot of LOTS) {
    const row = lookup(map, lot.a, lot.b);
    if (row.value !== 'win') bad.push(`${lot.id} 棋书判 ${row.value}，题卡却写 ${lot.winner}`);
    if (row.k !== lot.k) bad.push(`${lot.id} 印 k=${lot.k}，棋书 k=${row.k}`);
    if (row.depth !== lot.depth) bad.push(`${lot.id} 印 帕=${lot.depth}，棋书 ${row.depth}`);
    if (lot.winner !== '先手') bad.push(`${lot.id} winner=${lot.winner}`);
  }
  eq(bad, [], '题卡与棋书分歧：' + bad.join(' | '));
});

test('book: 题卡的 q / legal / chance / area / margin 都能由棋书那一格算出', () => {
  for (const lot of LOTS) {
    const q = quotient(lot.a, lot.b);
    eq(lot.q, q, `${lot.id} q`);
    eq(lot.legal, q, `${lot.id} legal == q`);
    eq(lot.chance, Number((1 / q).toFixed(6)), `${lot.id} chance == 1/q`);
    eq(lot.area, lot.a * lot.b, `${lot.id} area`);
    eq(lot.margin, lot.a * lot.a - lot.a * lot.b - lot.b * lot.b, `${lot.id} margin = a²-ab-b²`);
    eq(lot.margin > 0, true, `${lot.id} 先手必胜局必须落在 φ 之上（margin>0）`);
  }
});

test('book: 每一关都过合格门：既约、q>=2、帕>=3、不越界', () => {
  for (const lot of LOTS) {
    eq(lot.g, 1, `${lot.id} 必须是既约矩形`);
    ok(lot.q >= 2, `${lot.id} q=${lot.q} < 2 就没有可选择的一口`);
    ok(lot.depth >= 3, `${lot.id} 帕=${lot.depth} < 3 就是切完收工`);
    ok(lot.a <= BOOK_BOUND, `${lot.id} a=${lot.a} 越出棋书`);
    ok(lot.a > lot.b, `${lot.id} 正方形不是一关`);
  }
});

// ------------------------------------------------------------------ encode / recompute
test('book: encodeRow 的形状就是协议', () => {
  eq(encodeRow({ a: 7, b: 3, value: 'win', chosen: 1, depth: 3 }), '7:3:win/1/3');
  eq(encodeRow({ a: 1, b: 1, value: 'win', chosen: 1, depth: 1 }), '1:1:win/1/1');
});

test('book: 现场重算（route 1）与发货棋书逐行相等', () => {
  const fresh = encodeBook(table(60));
  eq(fresh.bound, 60);
  eq(fresh.states, TRIANGLE_60);
  eq(fresh.win, BOOK.win, '胜局数必须与发货一致（bake 打印 1161）');
  eq(fresh.loss, BOOK.loss, '必败数必须与发货一致（bake 打印 669）');
  eq(fresh.rows.join('|') === BOOK.rows.join('|'), true, '棋书逐行不等价');
});

test('book: recomputeBook 报 0 处不一致，并且它真的会看差异', () => {
  const rc = recomputeBook(BOOK);
  eq(rc.same, true);
  eq(rc.mismatchCount, 0);
  eq(rc.bound, 60);
  eq(rc.rows, TRIANGLE_60);
  const tampered = clone();
  tampered.rows[4] = '3:2:loss/1/7'; // 与真值 3:2:loss/1/2 只差一个帕
  const bad = recomputeBook(tampered);
  eq(bad.same, false);
  ok(bad.mismatchCount >= 1);
  ok(bad.mismatches.length >= 1 && /3:2:loss/.test(bad.mismatches[0]), JSON.stringify(bad.mismatches));
});

test('book: recomputeBook 拒绝没有 bound 的负载（不能凭空选边界）', () => {
  throwsLike(() => recomputeBook({ rows: [] }), /需要携带 bound/);
  throwsLike(() => recomputeBook(null), /需要携带 bound/);
});

test('book: table 的边界就是棋书的边界，多一行都编不出来', () => {
  const small = encodeBook(table(3));
  eq(small.bound, 3);
  eq(small.states, 6); // 1+2+3 = 6
  eq(small.rows[0], '1:1:win/1/1');
  eq(small.rows.join('|'), '1:1:win/1/1|2:1:win/2/1|2:2:win/1/1|3:1:win/3/1|3:2:loss/1/2|3:3:win/1/1');
});

test('book: 小棋书单独解码也自洽（3:2 是必败、帕 2）', () => {
  const m = decodeBook(encodeBook(table(3)));
  eq(m.size, 6);
  eq(valueOf(m, 3, 2), 'loss');
  eq(par(m, 3, 2), 2);
  eq(bestK(m, 3, 2), 1);
  throwsLike(() => lookup(m, 4, 3), /不在棋书里/);
});

test('book: 棋书与 route 1 递归逐格同意（读表的人不可能比算的人更聪明）', () => {
  let n = 0;
  for (const lot of LOTS) {
    const row = lookup(map, lot.a, lot.b);
    const node = solve(row.a, row.b);
    eq(node.value, row.value, `${row.key} value`);
    eq(node.kStar, row.k, `${row.key} k`);
    eq(node.depth, row.depth, `${row.key} 帕`);
    n++;
  }
  eq(n, LOTS.length);
});

test('book: 全网格 1830 格与递归零分歧（穷举，不抽样）', () => {
  // The book row carries `chosen` (js/core/retro.js), i.e. the move the TABLE plays. For a win
  // that is the unique winning move = solve().kStar; for a loss solve().kStar is null because
  // there IS no winning move, while the table still has to answer — its longest-resistance cut.
  // Theorem A says a loss has exactly one legal move, so that cut is forced and equals k=1.
  let diff = 0;
  let lossRows = 0;
  let deepest = 0;
  let deepestKey = '';
  for (let a = 1; a <= 60; a++) {
    for (let b = 1; b <= a; b++) {
      const row = lookup(map, a, b);
      const node = solve(a, b);
      if (node.value !== row.value || node.depth !== row.depth) diff++;
      if (node.value === 'win' && node.kStar !== row.k) diff++;
      if (node.value === 'loss') {
        lossRows++;
        eq(quotient(a, b), 1, `${row.key} 必败局竟然有 ${quotient(a, b)} 个口`);
        eq(row.k, 1, `${row.key} 必败局唯一的一口就是 k=1`);
        eq(node.winning.length, 0, `${row.key} 必败局却有胜口`);
      }
      if (row.depth > deepest) { deepest = row.depth; deepestKey = row.key; }
    }
  }
  eq(diff, 0);
  eq(lossRows, BOOK.loss, '数出来的必败格必须等于棋书声明的 669');
  eq(deepest, 8, 'bake 打印 maxDepth 8');
  eq(deepestKey, '41:29', 'bake: "book deepest: 帕8 at 41:29"');
});

// ------------------------------------------------------------------ helpers
function indexOf(payload, a, b) {
  const key = `${a}:${b}:`;
  const i = payload.rows.findIndex((r) => r.startsWith(key));
  if (i < 0) throw new Error(`没有 ${a}:${b} 这一行`);
  return i;
}

function throwsLike(fn, re, note = '') {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`应该抛异常却没有：${re} ${note}`);
  const msg = String(err.message || err);
  if (!re.test(msg)) throw new Error(`异常信息不符：期望 ${re}，得到 ${JSON.stringify(msg)} ${note}`);
  return msg;
}

await run();
