// test/game.test.mjs — the state machine, on its own terms.
//
// Three things this suite refuses to let slide:
//   1. an illegal cut is ANSWERED, not swallowed: one line of reason, and the state is the state
//      it was (same rectangle, same ply count, same snapshots, same history);
//   2. one gesture = one pair of plies = one snapshot per ply, so 撤销 can walk it back exactly;
//   3. the hint never lies, and it is checked EXHAUSTIVELY: for every shipped lot and every legal
//      first cut (not a sample), only the book's own k leaves the player a winning position.
//
// Expectations are hand-derived where a number is involved; the arithmetic is in the comment.
//   node test/game.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';
import {
  aiTurn, classifyNow, cutFootprint, hintAt, perfectLine, playToTable, playCut, playerCut,
  startMatch, undoRound, SEATS,
} from '../js/core/game.js';
import { bestK, lookup, par } from '../js/core/book.js';
import { bookMap, lots } from '../js/core/library.js';
import { legalMoves, quotient, squareCount, successor } from '../js/core/euclid.js';

const map = bookMap();
const lotOf = (a, b, extra = {}) => ({ id: `t-${a}x${b}`, tier: 'test', a, b, ...extra });

// The four shipped lots of the first band plus the fixture pairs the docs quote; the exhaustive
// first-cut sweep at the bottom walks ALL 32 shipped lots.
const NUGGET = lots.filter((l) => l.tier === 'nugget');

// ------------------------------------------------------------------ the opening
test('game: 开局状态就是题卡那一格，先手是你，一口都没记', () => {
  const lot = NUGGET[0];
  const st = startMatch(lot);
  eq(st.lotId, lot.id);
  eq([st.a, st.b], [lot.a, lot.b]);
  eq(st.root, [lot.a, lot.b]);
  eq(st.turn, 'you');
  eq(st.plies, 0);
  eq(st.youCuts, 0);
  eq(st.aiCuts, 0);
  eq(st.squares, 0);
  eq(st.status, 'playing');
  eq(st.winner, null);
  eq(st.snapshots, []);
  eq(st.history, []);
});

test('game: 开局那句话把可切范围写在脸上（q = floor(a/b)）', () => {
  // hand-derived: 12×5 → q = floor(12/5) = 2, so the line must offer k = 1..2
  const lot = lots.find((l) => l.a === 12 && l.b === 5);
  ok(lot, '12×5 应当是发货的一关');
  eq(quotient(12, 5), 2);
  const st = startMatch(lot);
  eq(st.line, '金条 12×5，你先切。长边可切 1–2 块 5×5。');
});

test('game: classifyNow 在开局说 必胜 / 对你 / 表里的帕与 k', () => {
  for (const lot of lots) {
    const st = startMatch(lot);
    const c = classifyNow(map, st);
    eq(c.value, 'win', `${lot.id} 每一关都是先手必胜`);
    eq(c.verdict, '必胜');
    eq(c.forSeat, SEATS.you);
    eq(c.par, lot.depth, `${lot.id} 帕`);
    eq(c.k, lot.k, `${lot.id} 唯一胜口`);
    eq(c.q, lot.q);
    eq(c.key, `${lot.a}:${lot.b}`);
  }
});

test('game: 席位名字只有一个来源', () => {
  eq(SEATS, { you: '你', ai: '对手' });
});

// ------------------------------------------------------------------ illegal input
test('game: k=0 被拒：一句话理由，状态一格没动', () => {
  const st = startMatch(NUGGET[0]);
  const frozen = JSON.stringify(st);
  const r = playCut(map, st, 0, 'you');
  eq(r.rejected, '至少要把一块方金切下来（k 必须 >= 1）');
  eq(r.state.a, st.a);
  eq(r.state.plies, 0);
  eq(r.state.snapshots.length, 0);
  eq(r.state.history.length, 0);
  ok(r.state.line.includes('不能这样切'), r.state.line);
  eq(r.state.status, 'playing');
  eq(JSON.stringify(st), frozen, '入参被改写了：状态机不再纯');
});

test('game: k 超出 q 被拒，理由里带上限', () => {
  // hand-derived: 12×5, q = 2 ⇒ k = 3 would cut the long side negative
  const st = startMatch(NUGGET[0]);
  const r = playCut(map, st, 3, 'you');
  eq(r.rejected, '最多只能切 2 块（k=3 会把长边切负）');
  eq(r.state.plies, 0);
  eq(r.state.a, 12);
});

test('game: 非整数的 k 也被拒（1.5 / NaN / 字符串 / null）', () => {
  const st = startMatch(NUGGET[0]);
  for (const k of [1.5, NaN, '1', null, undefined, Infinity]) {
    const r = playCut(map, st, k, 'you');
    eq(r.rejected, 'k 不是整数', `k=${String(k)}`);
    eq(r.state.plies, 0);
  }
});

test('game: 每一句拒绝都是单行、非空、可念出来的', () => {
  const st = startMatch(NUGGET[0]);
  const bads = [0, 99, 1.25, 'x'];
  for (const k of bads) {
    const r = playCut(map, st, k, 'you');
    ok(r.rejected && r.rejected.length > 0, '没有理由的拒绝就是沉默');
    ok(!/[\n\r]/.test(r.rejected), JSON.stringify(r.rejected));
    ok(!/[\n\r]/.test(r.state.line), r.state.line);
  }
});

test('game: 换手被拒：对手没走的时候你不能替他走', () => {
  const st = startMatch(NUGGET[0]);
  const after = playerCut(map, st, NUGGET[0].k);
  eq(after.state.turn, 'you');
  const r = playCut(map, after.state, 1, 'ai');
  ok(/还没轮到对手/.test(r.rejected), r.rejected);
  eq(r.state.plies, after.state.plies);
});

test('game: aiTurn 只在轮到对手时动，否则一句话退回', () => {
  const st = startMatch(NUGGET[0]);
  const r = aiTurn(map, st);
  eq(r.rejected, '不该对手走');
  eq(r.state, st, '不该动的时候必须一模一样地退回');
});

test('game: 终局之后一切输入都被拒', () => {
  let st = startMatch({ id: 'x', tier: 't', a: 2, b: 1 });
  const win = playCut(map, st, 2, 'you');
  eq(win.rejected, null);
  eq(win.state.status, 'won');
  eq(win.state.winner, 'you');
  ok(/铺满/.test(win.state.line), win.state.line);
  const again = playCut(map, win.state, 1, 'you');
  eq(again.rejected, '本局已结束');
  eq(again.state.line, '本局已经结束，先重开再切');
  eq(again.state.status, 'won');
});

// ------------------------------------------------------------------ plies & snapshots
test('game: 一个手势 = 两手 = 两条快照（快照记的是走之前）', () => {
  const lot = NUGGET[0];
  eq(lot.depth >= 3, true);
  const st = startMatch(lot);
  const r = playerCut(map, st, lot.k);
  eq(r.rejected, null);
  eq(r.state.plies, 2, '你一口 + 对手一口');
  eq(r.state.snapshots.length, 2, '每一手一条快照，多一条少一条都撤不对');
  eq(r.state.youCuts, 1);
  eq(r.state.aiCuts, 1);
  eq(r.state.turn, 'you');
  // snapshots[i] is the state BEFORE ply i: the first is the opening rectangle
  eq([r.state.snapshots[0].a, r.state.snapshots[0].b], [lot.a, lot.b]);
  eq(r.state.snapshots[0].turn, 'you');
  eq(r.state.snapshots[1].turn, 'ai');
  eq(r.state.snapshots[1].plies, 1);
});

test('game: 切下的方金数就是 k，块数 footprint = k·b²（手推）', () => {
  // hand-derived: 12×5 cut with k=1 removes one 5×5 block = 25 unit squares = 1·5²
  const lot = lots.find((l) => l.a === 12 && l.b === 5);
  const st = startMatch(lot);
  eq(cutFootprint(st, 1), 25);
  eq(cutFootprint(st, 2), 50, '2·5² —— 两口都是 5×5 的方块');
  // 12 = 2·5 + 2: even the widest cut leaves the 2×5 remainder strip on the bar, so the footprint
  // is 50 of the 60 unit squares, not the whole bar. Only an exact bar can be fully consumed.
  eq(cutFootprint(st, quotient(12, 5)), 50);
  eq(cutFootprint(st, 2), 12 * 5 - (12 - 2 * 5) * 5);
  const exact = startMatch({ id: 'x6x2', tier: 't', a: 6, b: 2 });
  eq(cutFootprint(exact, 3), 12, '6×2 切 3 块 = 整条 12 格，正好铺满');
  const r = playerCut(map, st, 1);
  eq(r.state.squares, 2, '你 1 块 + 对手 1 块');
  eq(r.state.history[0].k, 1);
  eq(r.state.history[0].side, 5, '第一口切的是 5×5');
  eq(r.state.history[0].seat, 'you');
});

test('game: 后继矩形归一化 —— 转 90° 要写在行里', () => {
  // hand-derived: 12×5 切 k=1 → 7×5（长边还是 7 > 5，不转）；切 k=2 → 2×5 → 归一化 5×2（转）
  eq(successor(12, 5, 1), [7, 5]);
  eq(successor(12, 5, 2), [5, 2]);
  const lot = lots.find((l) => l.a === 12 && l.b === 5);
  const straight = playCut(map, startMatch(lot), 1, 'you');
  ok(!/转了 90°/.test(straight.state.line), straight.state.line);
  ok(/你切 1 块 5×5，剩 7×5/.test(straight.state.line), straight.state.line);
  const turned = playCut(map, startMatch(lot), 2, 'you');
  ok(/转了 90°/.test(turned.state.line), turned.state.line);
  ok(/剩 5×2/.test(turned.state.line), turned.state.line);
  eq([turned.state.a, turned.state.b], [5, 2]);
});

test('game: history 每一手都记着自己的席位、口数与是否铺满', () => {
  const lot = lots.find((l) => l.a === 12 && l.b === 5);
  const end = playToTable(map, startMatch(lot));
  eq(end.state.history.length, lot.depth, '帕 = 手数');
  eq(end.state.history.map((h) => h.seat).join(','), 'you,ai,you,ai,you', '先手收满：五手的席位');
  eq(end.state.history.filter((h) => h.exact).length, 1, '只有最后一手铺满');
  eq(end.state.history[end.state.history.length - 1].exact, true);
});

// ------------------------------------------------------------------ the opponent is the table
test('game: 对手的每一手都等于棋书那一行的 k（它没有别的想法）', () => {
  for (const lot of lots) {
    const end = playToTable(map, startMatch(lot));
    let [a, b] = [lot.a, lot.b];
    for (const h of end.state.history) {
      eq(h.k, bestK(map, a, b), `${lot.id} 在 ${a}:${b} 的着法不是表里的`);
      const next = successor(a, b, h.k);
      if (next === null) break;
      [a, b] = next;
    }
  }
});

test('game: 照表收局每一关都在印着的帕数上结束，收满的是先手', () => {
  for (const lot of lots) {
    const r = perfectLine(map, lot);
    eq(r.lotId, lot.id);
    eq(r.plies, lot.depth, `${lot.id} 实走 ${r.plies} != 帕 ${lot.depth}`);
    eq(r.par, lot.depth);
    eq(r.winner, 'you', `${lot.id} 两席都照表走时先手必须收满`);
    // hand-derived identity: perfect play cuts exactly the greedy Euclid square count
    eq(r.squares, squareCount(lot.a, lot.b), `${lot.id} 切下的方金总数 == Σ 部分商`);
  }
});

test('game: 先手第一口切对，之后整条线都是逼的', () => {
  for (const lot of lots) {
    // the intermediate hand-off: your cut alone leaves the OPPONENT a loss
    const handed = playCut(map, startMatch(lot), lot.k, 'you');
    eq(handed.rejected, null, `${lot.id} 唯一胜口竟然被拒`);
    if (handed.state.status === 'playing') {
      eq(handed.state.turn, 'ai');
      eq(classifyNow(map, handed.state).value, 'loss', `${lot.id} 切对之后对手不是必败`);
      eq(classifyNow(map, handed.state).forSeat, SEATS.ai);
      eq(classifyNow(map, handed.state).par, lot.depth - 1, `${lot.id} 一手之后帕减 1`);
    }
    // one gesture later (对手被迫回口) the player is still winning, now at 帕-2
    const first = playerCut(map, startMatch(lot), lot.k);
    eq(first.rejected, null);
    if (first.state.status === 'playing') {
      eq(classifyNow(map, first.state).value, 'win', `${lot.id} 切对之后玩家不该被判负`);
      eq(classifyNow(map, first.state).par, lot.depth - 2, `${lot.id} 两口之后帕减 2`);
      const rest = playToTable(map, first.state);
      eq(rest.state.status, 'won');
      eq(rest.state.plies, lot.depth, `${lot.id} 切对之后总手数 == 帕`);
    }
  }
});

// ------------------------------------------------------------------ the hint never lies
test('game: 提示说的胜口就是表里那一口，并且把 1/q 报出来', () => {
  // hand-derived for 12×5: q = 2 ⇒ the hint can only be wrong by a coin flip
  const lot = lots.find((l) => l.a === 12 && l.b === 5);
  const h = hintAt(map, startMatch(lot));
  eq(h.winning, true);
  eq(h.k, 1);
  eq(h.q, 2);
  eq(h.par, 5);
  eq(h.line, '唯一胜口：切 1 块 5×5（可选 1–2，猜中概率 1/2）');
});

test('game: 必败局里提示不编胜口，只说帕和拖延的那一口', () => {
  // hand-derived: 3×2 ⇒ 9 < 6 + 4，必败，只剩 k=1 → 2×1 让对手铺满，帕 2
  const st = startMatch(lotOf(3, 2));
  eq(lookup(map, 3, 2).value, 'loss');
  const h = hintAt(map, st);
  eq(h.winning, false);
  eq(h.k, null, '必败局报出 k 就是谎报');
  eq(h.par, 2);
  eq(h.q, 1);
  ok(/已经必败/.test(h.line), h.line);
  ok(/切 1 块只是拖延/.test(h.line), h.line);
});

test('game: 穷举每一关每一个合法第一口 —— 只有表里的 k 活得下来', () => {
  let swept = 0;
  let wrongs = 0;
  for (const lot of lots) {
    const legal = legalMoves(lot.a, lot.b);
    eq(legal.length, lot.q, `${lot.id} 合法口数`);
    for (const k of legal) {
      swept++;
      const solo = playCut(map, startMatch(lot), k, 'you');
      eq(solo.rejected, null, `${lot.id} 合法口 k=${k} 被拒`);
      const r = playerCut(map, startMatch(lot), k);
      if (k === lot.k) {
        // your cut hands the opponent a loss, and its forced reply leaves you winning again
        if (solo.state.status === 'playing') {
          eq(classifyNow(map, solo.state).value, 'loss', `${lot.id} k=${lot.k} 之后对手不是必败`);
        } else {
          eq(solo.state.status, 'won', `${lot.id} k=${lot.k} 是铺满的一口`);
        }
        if (r.state.status === 'playing') {
          eq(classifyNow(map, r.state).value, 'win', `${lot.id} 切对 k=${k} 之后玩家被判负`);
          eq(classifyNow(map, r.state).par, lot.depth - 2, `${lot.id} 两口之后帕减 2`);
        }
      } else {
        wrongs++;
        eq(classifyNow(map, solo.state).value === 'loss', false, `${lot.id} 切错 k=${k} 竟然送对手一个必败`);
        if (r.state.status === 'playing') {
          eq(classifyNow(map, r.state).value, 'loss', `${lot.id} 切错 k=${k} 之后玩家竟然还有胜局`);
        } else {
          eq(r.state.status, 'lost', `${lot.id} 切错 k=${k} 之后赢家不是对手？`);
          eq(r.state.winner, 'ai');
        }
      }
    }
  }
  ok(swept >= 64, `穷举覆盖太少：${swept}`);
  ok(wrongs >= 32, `错口样本太少：${wrongs}`);
});

test('game: 切错之后照表收局，玩家一定输（必败局没有第二条路）', () => {
  for (const lot of lots) {
    const legal = legalMoves(lot.a, lot.b);
    for (const k of legal) {
      if (k === lot.k) continue;
      const r = playerCut(map, startMatch(lot), k);
      if (r.state.status !== 'playing') continue;
      const end = playToTable(map, r.state);
      eq(end.state.status, 'lost', `${lot.id} 切错 k=${k} 之后照表走居然赢了`);
      eq(end.state.winner, 'ai');
    }
  }
});

test('game: 必败的一方只有一口可切，所以「抵抗最久」就是「唯一合法」', () => {
  // exhaustive over the whole book: every loss row has q = 1, hence k = 1
  for (let a = 1; a <= 60; a++) {
    for (let b = 1; b <= a; b++) {
      const row = lookup(map, a, b);
      if (row.value !== 'loss') continue;
      eq(quotient(a, b), 1, `${a}:${b} 必败局有 ${quotient(a, b)} 个口`);
      eq(row.k, 1);
      const st = startMatch(lotOf(a, b));
      const h = hintAt(map, st);
      eq(h.winning, false);
      eq(h.line.includes('已经必败'), true);
    }
  }
});

// ------------------------------------------------------------------ undo
test('game: 撤销回到你上一切之前，一整个手势一起消失', () => {
  const lot = NUGGET[0];
  const r = playerCut(map, startMatch(lot), lot.k);
  eq(r.state.plies, 2);
  const u = undoRound(r.state);
  eq(u.rejected, null);
  eq(u.state.plies, 0);
  eq([u.state.a, u.state.b], [lot.a, lot.b]);
  eq(u.state.turn, 'you');
  eq(u.state.snapshots.length, 0);
  eq(u.state.history.length, 0);
  eq(u.state.squares, 0);
  eq(u.state.youCuts, 0);
  eq(u.state.aiCuts, 0);
  eq(u.state.status, 'playing');
  eq(u.state.line, `退回你第 1 切之前：金条 ${lot.a}×${lot.b}`);
});

test('game: 中途撤销只回一手，剩下的手数仍然自洽', () => {
  const lot = lots.find((l) => l.depth >= 5) || NUGGET[0];
  const one = playerCut(map, startMatch(lot), lot.k);
  const two = playerCut(map, one.state, bestK(map, one.state.a, one.state.b));
  ok(two.state.plies >= 4, '两回合应该至少四手');
  const back = undoRound(two.state);
  eq(back.state.plies, one.state.plies);
  eq([back.state.a, back.state.b], [one.state.a, one.state.b]);
  eq(back.state.snapshots.length, one.state.snapshots.length);
  eq(par(map, back.state.a, back.state.b), par(map, one.state.a, one.state.b));
});

test('game: 没东西可撤的时候它说一句话，而不是崩', () => {
  const st = startMatch(NUGGET[0]);
  const r = undoRound(st);
  eq(r.rejected, '没有可撤销的着法');
  eq(r.state, st);
});

test('game: 输了可以撤回去重下（撤销把终局也一并收回）', () => {
  const lot = NUGGET[0];
  const wrong = legalMoves(lot.a, lot.b).find((k) => k !== lot.k);
  let st = playerCut(map, startMatch(lot), wrong).state;
  if (st.status === 'playing') st = playToTable(map, st).state;
  eq(st.status, 'lost');
  eq(st.winner, 'ai');
  const undone = undoRound(st);
  eq(undone.state.status, 'playing', '撤销之后必须还能下');
  eq(undone.state.winner, null);
  const replay = playToTable(map, undone.state);
  ok(replay.state.plies > undone.state.plies, '棋盘上还有子可下');
  ok(replay.state.status === 'lost' || replay.state.status === 'won');
});

test('game: playToTable 拒绝走不完的局面（模型有环就是 bug，不是平局）', () => {
  const lot = NUGGET[0];
  const r = playToTable(map, startMatch(lot), 200);
  ok(r.plies > 0 && r.plies < 200);
  eq(r.line.length, r.plies, '每一手都要留下一行记录');
  let threw = null;
  try { playToTable(map, startMatch(lot), 1); } catch (e) { threw = String(e.message); }
  ok(threw && /手内没有终局/.test(threw), threw);
});

test('game: 每一手都让长边严格变小（这就是它会结束的原因）', () => {
  for (const lot of lots) {
    const end = playToTable(map, startMatch(lot));
    eq(end.state.history.length, end.line.length);
    let prev = lot.a;
    for (let i = 0; i < end.line.length; i++) {
      const step = end.line[i];
      const last = i === end.line.length - 1;
      if (last) {
        // the final ply tiles the bar: a and b stay as they were so the view can still draw it
        eq(step.to[0], prev, `${lot.id} 终局长边不该变`);
      } else {
        ok(step.to[0] < prev, `${lot.id} 第 ${i + 1} 手长边没有变短（${prev} → ${step.to[0]}）`);
      }
      ok(step.to[0] >= step.to[1] && step.to[1] >= 1, `${lot.id} 后继未归一化 ${step.to}`);
      prev = step.to[0];
    }
  }
});

await run();
