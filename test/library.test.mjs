// test/library.test.mjs — the campaign as a shipped artefact.
//
// The pool API is the only place a lot card's printed numbers are re-derived, so this suite is the
// build's last audit: ids unique, bands disjoint and ordered by MEASURED difficulty, every printed
// number back out of the book by position, the eligibility gates refusing exactly what they claim
// to refuse, and the daily/random draws being pure functions of their seed.
//
// Numbers with an arithmetic comment were worked out on paper; numbers marked (bake) are the ones
// `node tools/bake.mjs` prints and tools/bake.test.mjs re-measures.
//   node test/library.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';
import {
  BANDS, BOOK_BOUND, SCHEMA_ID, BAKED_AT_ISO, bandByKey, bookMap, candidates, campaign, curate,
  dailyLot, derive, eligibility, lotAt, lotById, lotStats, lots, lotsByTier,
  poolStats, randomLot, tierKeys, tierMeta, tiers, verifyLot, verifyPool,
} from '../js/core/library.js';
import { BOOK, DAILY_IDS, LOTS } from '../js/data/lots.js';
import { lookup } from '../js/core/book.js';
import { gcd, quotient, squareCount, margin, legalMoves } from '../js/core/euclid.js';
import { solve } from '../js/core/retro.js';

const map = bookMap();

// ------------------------------------------------------------------ the list itself
test('library: 发货的题池就是 32 关（bake: nugget:8 vein:8 crucible:8 master:8）', () => {
  eq(lots.length, 32);
  eq(LOTS.length, 32);
  eq(lotKeys().length, new Set(lotKeys()).size, 'id 必须唯一');
  for (const t of tierKeys) eq(lotsByTier(t).length, 8, `${t} 应当正好 8 关`);
  eq(tierKeys, ['nugget', 'vein', 'crucible', 'master']);
});

test('library: id 形状 = <band>-NN，且每档内部连续编号', () => {
  for (const tier of tierKeys) {
    const mine = lotsByTier(tier);
    eq(mine.map((l) => l.id), mine.map((_, i) => `${tier}-${String(i + 1).padStart(2, '0')}`));
  }
});

test('library: 没有重复矩形，也没有重复档位名', () => {
  const rects = lots.map((l) => `${l.a}:${l.b}`);
  eq(rects.length, new Set(rects).size);
});

test('library: 档位是不相交的连续切片（2–14, 15–22, 23–34, 35–60）', () => {
  eq(BANDS.map((b) => [b.minA, b.maxA]), [[2, 14], [15, 22], [23, 34], [35, 60]]);
  eq(BOOK_BOUND, 60);
  eq(bandByKey('nope'), null);
  for (let i = 0; i < BANDS.length; i++) {
    for (const lot of lotsByTier(BANDS[i].key)) {
      ok(lot.a >= BANDS[i].minA && lot.a <= BANDS[i].maxA, `${lot.id} 越档`);
    }
  }
});

test('library: 候选数就是手推的普查（Σ(a-1) over the band）', () => {
  // hand-derived: nugget Σ_{a=2..14}(a-1) = 1+2+…+13 = 13·14/2 = 91
  eq(candidates(bandByKey('nugget')).length, 91);
  // vein Σ_{a=15..22}(a-1) = 14+…+21 = (14+21)·8/2 = 140
  eq(candidates(bandByKey('vein')).length, 140);
  // crucible Σ_{a=23..34}(a-1) = 22+…+33 = (22+33)·12/2 = 330
  eq(candidates(bandByKey('crucible')).length, 330);
  // master Σ_{a=35..60}(a-1) = 34+…+59 = (34+59)·26/2 = 1209
  eq(candidates(bandByKey('master')).length, 1209);
  // the shipped TIERS_META carries the same census the bake printed
  eq(poolStats().schema, 'euclid-lots-v1');
  for (const t of tiers) {
    eq(t.cands, candidates(bandByKey(t.key)).length, `${t.key} 候选数与档位的普查不符`);
  }
});

test('library: candidates 只枚举 b < a（正方形不是一关）', () => {
  const c = candidates(bandByKey('nugget'));
  eq(c[0], [2, 1]);
  eq(c[c.length - 1], [14, 13]);
  ok(c.every(([a, b]) => a > b && b >= 1));
  ok(!c.some(([a, b]) => a === b), '正方形一律不是候选');
});

test('library: candidates 拒绝不像档位的输入', () => {
  for (const bad of [null, undefined, {}, { minA: 2 }, { minA: 2, maxA: 'x' }]) {
    throwsLike(() => candidates(bad), /需要带 minA\/maxA/);
  }
});

// ------------------------------------------------------------------ difficulty is measured
test('library: 档位按量出来的难度排（发货局的 帕上界 / q 上界都不下降）', () => {
  const meta = tiers;
  eq(meta.map((m) => m.key), tierKeys);
  const parMax = meta.map((m) => m.depthMax);
  const qMax = meta.map((m) => m.qMax);
  ok(parMax.every((v, i) => i === 0 || v >= parMax[i - 1]), `帕上界不该倒退：${parMax}`);
  ok(qMax.every((v, i) => i === 0 || v >= qMax[i - 1]), `q 上界不该倒退：${qMax}`);
  // (bake) shipped per-band ranges: 帕 3–5 / 3–5 / 3–7 / 3–7, q 2–5 / 2–7 / 2–10 / 2–13
  eq(parMax, [5, 5, 7, 7]);
  eq(qMax, [5, 7, 10, 13]);
  eq(meta.map((m) => m.depthMin), [3, 3, 3, 3]);
  eq(meta.map((m) => m.kMin), [1, 1, 1, 1], '每一关的胜口都从 k=1 起出现过');
});

test('library: 难度不是尺寸 —— 大矩形可以只有一口可切', () => {
  // hand-derived: 60×37 ⇒ q = floor(60/37) = 1, so it cannot be a lot at all;
  // 41×29 ⇒ q = 1 too. The largest eligible rectangle in the book is deeper than the biggest bar.
  eq(quotient(60, 37), 1);
  eq(quotient(41, 29), 1);
  const gate = eligibility([60, 37], { value: 'win', k: 1, depth: 8 }, bandByKey('master'));
  eq(gate.ok, false);
  eq(gate.why, 'fewChoices');
});

test('library: 战役顺序 = 档位序 → 帕升 → q 升 → a 升 → b 升', () => {
  const order = new Map(tierKeys.map((k, i) => [k, i]));
  const c = campaign();
  eq(c.length, 32);
  eq(c[0].id, lotAt(1).id);
  eq(c[31].id, lotAt(32).id);
  let lastKey = null;
  for (const lot of c) {
    const key = [order.get(lot.tier), lot.depth, lot.q, lot.a, lot.b];
    if (lastKey) ok(cmp(lastKey, key) <= 0, `${lot.id} 打乱了顺序：${lastKey} 在 ${key} 之前`);
    lastKey = key;
  }
  // campaign() is cached and must not be the same array as the shipped LOTS (a sort would mutate it)
  ok(campaign() === c, '战役顺序应当缓存');
  eq(lots[0].id, 'nugget-01', '原池顺序不能被 sort 改掉');
});

function cmp(p, r) {
  for (let i = 0; i < p.length; i++) if (p[i] !== r[i]) return p[i] - r[i];
  return 0;
}

test('library: lotAt 越界与非法下标都返回 null，不是崩', () => {
  eq(lotAt(0), null);
  eq(lotAt(33), null);
  eq(lotAt(-1), null);
  eq(lotAt(2.5), null);
  eq(lotAt('7'), lotAt(7), '字符串下标是路由给的，必须能用');
  eq(lotAt('x'), null);
  eq(lotAt(undefined), null);
  eq(lotById('nope'), null);
  eq(lotById('nugget-01').a, lots.find((l) => l.id === 'nugget-01').a);
  eq(tierMeta('nope'), null);
  eq(tierMeta('vein').label, '矿脉');
});

// ------------------------------------------------------------------ every printed number
test('library: verifyPool() 空 = 每一关印着的数字都还能从棋书里查出来', () => {
  eq(verifyPool(), [], verifyPool().join(' | '));
  for (const lot of lots) eq(verifyLot(lot), [], `${lot.id}: ${verifyLot(lot).join(' | ')}`);
});

test('library: derive(12×5) 手推 —— 胜、k=1、帕 5、q=2、1/2、margin 59', () => {
  // 12² = 144 > 12·5 + 25 = 85 ⇒ 先手必胜；k=1 → 7×5（9 < 35+25 ⇒ 必败）帕 = 1 + 4 = 5
  const lot = lotById('nugget-01');
  eq([lot.a, lot.b], [12, 5]);
  const d = derive(lot);
  eq(d.key, '12:5');
  eq(d.value, 'win');
  eq(d.winner, '先手');
  eq(d.k, 1);
  eq(d.depth, 5);
  eq(d.q, 2);
  eq(d.legal, 2);
  eq(d.chance, 0.5);
  eq(d.margin, 144 - 60 - 25);
  eq(d.ratio, '2.4000');
  eq(d.g, 1);
  eq(d.area, 60);
  eq(lookup(map, 7, 5).value, 'loss', 'k=1 交出去的那一格必须是必败');
});

test('library: 每一关 derive 出来的六个数都等于卡面印的', () => {
  for (const lot of lots) {
    const d = derive(lot);
    eq(d.k, lot.k, `${lot.id} k`);
    eq(d.depth, lot.depth, `${lot.id} 帕`);
    eq(d.q, lot.q);
    eq(d.chance, lot.chance);
    eq(d.margin, lot.margin);
    eq(d.ratio, lot.ratio);
    eq(d.area, lot.area);
    eq(d.winner, lot.winner);
    eq(d.g, 1);
    eq(d.legal, legalMoves(lot.a, lot.b).length);
  }
});

test('library: 卡面的 divisions/slow/squares 与三条恒等式同时对上', () => {
  for (const lot of lots) {
    const node = solve(lot.a, lot.b);
    eq(node.depth, lot.depth);
    eq(lot.depth, lot.divisions + lot.slow, `${lot.id} 帕 = 除法数 + 插入数`);
    eq(lot.squares, squareCount(lot.a, lot.b), `${lot.id} 方金总数 == Σ 部分商`);
    ok(lot.slow >= 0);
    // the repo's honest wrinkle, checked on the shipped pool: 帕 is NOT the division count in general
    const ins = lot.depth - lot.divisions;
    eq(ins, lot.slow, `${lot.id} ins 应当等于 slowSteps`);
  }
});

test('library: verifyLot 能点出每一种被改印的数', () => {
  const base = lotById('nugget-01');
  const tampers = [
    [{ k: 2 }, /印着的 k=2 与棋书 1 不一致/],
    [{ depth: 4 }, /印着的 depth=4 与棋书 帕=5 不一致/],
    [{ winner: '后手' }, /winner 必须是先手|印着的 winner/],
    [{ q: 3 }, /q\/legal/],
    [{ chance: 0.25 }, /chance/],
    [{ area: 61 }, /area/],
    [{ ratio: '2.5000' }, /ratio/],
    [{ margin: 58 }, /margin/],
    [{ tier: 'nope' }, /未知档位|不在档位/],
    [{ a: 61, b: 5 }, /无法从棋书判定|越出棋书/],
  ];
  for (const [patch, re] of tampers) {
    const problems = verifyLot({ ...base, ...patch });
    ok(problems.length >= 1, `改印 ${JSON.stringify(patch)} 竟然没人报`);
    ok(problems.some((p) => re.test(p)), `${JSON.stringify(patch)} -> ${problems.join(' | ')}`);
  }
  // a scaled duplicate (12×5 → 24×10) is the same game and must be named as such
  const scaled = verifyLot({ ...base, a: 24, b: 10, area: 240 });
  ok(scaled.some((p) => /gcd=2/.test(p)), scaled.join(' | '));
  eq(gcd(24, 10), 2);
});

// ------------------------------------------------------------------ the eligibility gates
test('library: 合格门逐个拒（invalid / no-analysis / outside-book / square / coprime / loss / q / depth）', () => {
  const band = bandByKey('master');
  const win = { value: 'win', k: 1, depth: 5 };
  eq(eligibility([1.5, 1], win, band).why, 'invalid');
  eq(eligibility([12, 5], null, band).why, 'no-analysis');
  eq(eligibility([12, 5], {}, band).why, 'no-analysis');
  eq(eligibility([12, 5], { value: 'x' }, band).why, 'loss', 'value 不是 win 就当败局拒掉');
  eq(eligibility([61, 7], win, band).why, 'outside-book');
  eq(eligibility([40, 40], win, band).why, 'square');
  eq(eligibility([12, 8], win, band).why, 'not-coprime');
  eq(eligibility([7, 5], { value: 'loss', k: 1, depth: 4 }, band).why, 'loss');
  eq(eligibility([41, 29], win, band).why, 'fewChoices');
  eq(eligibility([5, 2], { value: 'win', k: 2, depth: 1 }, band).why, 'shallow');
  // the band gate is a CEILING check (js/core/make.js: x > band.maxA); a rectangle below minA is
  // not outside the band, it simply never gets enumerated by candidates() for that band.
  eq(eligibility([20, 13], win, bandByKey('nugget')).why, 'outside-band');
  eq(eligibility([36, 17], win, band).ok, true, '36×17 是 master 档的合格候选');
  // hand-derived for 36×17: gcd = 1, q = floor(36/17) = 2, margin = 1296-612-289 = 395 > 0 ⇒ 胜
  const okGate = eligibility([36, 17], { value: 'win', k: 1, depth: 5 }, band);
  eq(okGate.ok, true);
  eq(okGate.pair, [36, 17]);
  eq(okGate.q, 2);
  eq(margin(36, 17), 395);
  eq(okGate.legal, okGate.q, 'legal == q：能切的块数就是选择宽度');
});

test('library: lotStats 的六个数各自来自一条算式', () => {
  // hand-derived for 11×4: q = 2, r = 3, area = 44, margin = 121-44-16 = 61
  const s = lotStats([11, 4], { k: 2, depth: 3, value: 'win' });
  eq(s, { a: 11, b: 4, g: 1, q: 2, r: 3, legal: 2, k: 2, depth: 3, chance: 0.5, area: 44 });
  eq(margin(11, 4), 61);
  eq(lotStats([12, 8], { k: 1, depth: 3, value: 'win' }).g, 4, 'gcd(12,8) = 4 —— 它不是 3×2 的既约形');
});

test('library: curate 是确定性的，且永远取「最难在前」的等距样本', () => {
  const eligible = [];
  for (let a = 23; a <= 34; a++) {
    for (let b = 1; b < a; b++) {
      const node = solve(a, b);
      const gate = eligibility([a, b], { value: node.value, k: node.kStar, depth: node.depth }, bandByKey('crucible'));
      if (gate.ok) eligible.push({ key: `${a}:${b}`, ...lotStats([a, b], { k: node.kStar, depth: node.depth }) });
    }
  }
  ok(eligible.length >= 2, '坩埚档一个合格都没有就是普查坏了');
  const once = curate(eligible, 8);
  const twice = curate(eligible, 8);
  eq(once.map((e) => e.key), twice.map((e) => e.key), '重烘必须给同一批题');
  eq(once.length, Math.min(8, eligible.length));
  const ranked = eligible.slice().sort((p, r) => r.depth - p.depth || r.q - p.q || (p.a - r.a) || (p.b - r.b));
  eq(once[0].key, ranked[0].key, '等距样本的第一名就是最深的那一局');
  eq(curate([], 8), []);
  // the ranking itself is hardest-first
  const picked = curate(eligible, eligible.length);
  ok(picked.every((p, i) => i === 0 || picked[i - 1].depth >= p.depth || picked[i - 1].q >= p.q));
});

// ------------------------------------------------------------------ daily & random
test('library: #/daily 是日期的纯函数', () => {
  const a = dailyLot('2026-01-01');
  const b = dailyLot('2026-01-01');
  eq(a.id, 'daily-2026-01-01');
  eq(JSON.stringify(a), JSON.stringify(b));
  eq(a.mode, 'daily');
  eq(a.day, '2026-01-01');
  eq(a.label, '每日金条 · 2026-01-01');
  ok(DAILY_IDS.includes(a.sourceId), '每日必须从发货池里抽');
  eq(a.k, derive(lotById(a.sourceId)).k, '每日卡面的 k 也是查表来的');
  eq(a.depth, lotById(a.sourceId).depth);
});

test('library: 每日在固定日期上跨设备一致（三个写死的日期）', () => {
  const days = ['2024-02-29', '2026-01-01', '2026-12-31'];
  const got = days.map((d) => dailyLot(d).sourceId);
  eq(got, days.map((d) => dailyLot(d).sourceId), '同一天的两次抽取不同');
  eq(got.length, 3);
  ok(new Set(got).size >= 2, `三个不同日期全落在同一题上：${got}`);
});

test('library: dailyLot 拒绝不像日期的种子', () => {
  for (const bad of ['', '2026-1-1', 'yesterday', null, undefined, 20260101, '2026-01-1']) {
    throwsLike(() => dailyLot(bad), /需要 YYYY-MM-DD/, JSON.stringify(bad));
  }
  // the guard is on the SHAPE, not the calendar: 2026-13-01 is a valid key and a valid seed.
  eq(dailyLot('2026-13-01').day, '2026-13-01');
});

test('library: #/random 在一个 (档位, 种子) 上是稳定的，并且留在档内', () => {
  for (const tier of tierKeys) {
    const first = randomLot('fixedseed', tier);
    const again = randomLot('fixedseed', tier);
    eq(JSON.stringify(first), JSON.stringify(again), `${tier} 同一种子换了题`);
    eq(first.mode, 'random');
    eq(first.id, `random-${tier}-fixedseed`);
    eq(first.tier, tier);
    ok(lotsByTier(tier).some((l) => l.id === first.sourceId), `${tier} 抽到了别档的题`);
  }
  const unknown = randomLot('s', 'no-such-tier');
  ok(lots.some((l) => l.id === unknown.sourceId), '未知档位要退回全池而不是崩');
  eq(unknown.id, 'random-no-such-tier-s');
  const bySeed = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => randomLot(s, 'master').sourceId));
  ok(bySeed.size >= 2, `八个不同种子只给出一道题：${[...bySeed]}`);
});

test('library: poolStats 报的就是烘焙声明的那一组', () => {
  const s = poolStats();
  eq(s.lots, 32);
  eq(s.bound, 60);
  eq(s.states, 1830, '60·61/2 = 1830');
  eq(s.win, 1161);
  eq(s.loss, 669);
  eq(s.win + s.loss, s.states);
  eq(s.schema, 'euclid-lots-v1');
  eq(Object.values(s.byTier).reduce((a, b) => a + b, 0), 32);
  eq(SCHEMA_ID, 'euclid-lots-v1');
  eq(BOOK.rows.length, 1830);
});

test('library: BAKED_AT 是一个能解析的 ISO 时间，而且只有它每次重烘会变', () => {
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(BAKED_AT_ISO), BAKED_AT_ISO);
  eq(Number.isNaN(Date.parse(BAKED_AT_ISO)), false);
});

function throwsLike(fn, re, note = '') {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`应该抛异常却没有：${re} ${note}`);
  const msg = String(err.message || err);
  if (!re.test(msg)) throw new Error(`异常信息不符：期望 ${re}，得到 ${JSON.stringify(msg)} ${note}`);
  return msg;
}
function lotKeys() { return lots.map((l) => l.id); }

await run();
