// The content pipeline: everything the game prints is measured here, once, at build time.
//
// Two artefacts are written into js/data/lots.js:
//   1. BOOK — the exhaustive retrograde table of the whole position universe {1 <= b <= a <= 60},
//      one row per position: `<a>:<b>:<value>/<k>/<depth>`. The browser only ever looks things up
//      in it, which is how "the opponent is proven, not guessed" survives contact with a tap
//      handler (js/core/book.js `lookup` throws rather than search).
//   2. LOTS — the campaign. A rectangle only becomes a lot if BOTH independent routes agree on it
//      (route 1 = bottom-up retrograde grid, route 2 = the float-free φ algebra in
//      js/core/golden.js), and if it clears the band gates in js/core/make.js.
//
// The order of operations is the point of this file: reconciliation happens BEFORE any write, and
// every check below throws instead of logging. A bake that produced a disagreeing table would
// produce no file at all, so "the shipped book is the reconciled book" needs no discipline — only
// the exit code.
//
// Every number printed is a measurement this script performs, including the acceptance rates:
// candidates are a full census of a band, not a sample, so `eligible%` is exact.
//
//   node tools/bake.mjs
//   PER_BAND=10 node tools/bake.mjs
//   PHI_CENSUS_MAXA=2000 node tools/bake.mjs     (default 1200 = 720_600 pairs)
//
// Re-running must be reproducible for everything except BAKED_AT: no Math.random, no timing
// values written into the file, no iteration-order dependence (everything is sorted before it is
// compared or written). `test/bake.test.mjs` asserts the byte identity.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cfLength, cfQuotients, legalMoves, margin, pairKey, ratioText, squareCount,
} from '../js/core/euclid.js';
import { census as retroCensus, lineThrough, solve, table } from '../js/core/retro.js';
import { depth as gDepth, isLoss as gIsLoss, reconcile, slowSteps, winningMoves as gWinningMoves, census as phiCensus } from '../js/core/golden.js';
import { decodeBook, encodeBook, encodeRow } from '../js/core/book.js';
import { BANDS, BOOK_BOUND, candidates, curate, eligibility, lotStats, PER_BAND as SHIPPED_PER_BAND } from '../js/core/make.js';


const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_BAND = Number(process.env.PER_BAND || SHIPPED_PER_BAND);
const PHI_MAXA = Number(process.env.PHI_CENSUS_MAXA || 1200);
const UNIQUE_MAXA = Number(process.env.UNIQUE_CENSUS_MAXA || 300);
const SCHEMA = 'euclid-lots-v1';
const fail = (msg) => {
  throw new Error('bake: ' + msg);
};

const t0 = Date.now();
const ms = () => ((Date.now() - t0) / 1000).toFixed(2);

// ------------------------------------------------------- 1. route 1, and route 1 against itself
const grid = table(BOOK_BOUND);
const c60 = retroCensus(BOOK_BOUND, { grid, crossCheck: true });
console.log(`[${ms()}s] route1 grid a<=${BOOK_BOUND}: ${c60.positions} positions (${c60.win} win / ${c60.loss} loss) `
  + `· bottom-up vs memoised disagreements ${c60.disagreements} · multiWinning ${c60.multiWinning} `
  + `· lossWithChoice ${c60.lossWithChoice} · marginZero ${c60.marginZero} · maxDepth ${c60.maxDepth} (${c60.argmax.length} argmax)`);
if (c60.disagreements) fail(`两种控制流的穷举对 ${c60.disagreements} 个局面判得不一样`);
if (c60.multiWinning) fail(`胜利不唯一：${c60.multiWinning} 个局面有 >= 2 个胜口`);
if (c60.noWinning !== c60.loss) fail('判为胜局却数不出胜口');
if (c60.lossWithChoice) fail(`必败局却有选择：${c60.lossWithChoice} 个（Theorem A 被推翻）`);
if (c60.marginZero) fail('φ 被判成有理数：存在 a^2 = ab + b^2');

// ------------------------------------------------------- 2. route 2 against route 1, per state
const rec = reconcile(BOOK_BOUND);
if (rec.problems.length) fail(`φ 判据自身的结构检查失败：${rec.problems.slice(0, 3).join(' | ')}`);
let routeDiff = 0;
const routeDiffSamples = [];
for (const node of grid.values()) {
  const value = gIsLoss(node.a, node.b) ? 'loss' : 'win';
  const depth = gDepth(node.a, node.b);
  const slow = slowSteps(node.a, node.b);
  const cf = cfLength(node.a, node.b);
  const gWin = gWinningMoves(node.a, node.b);
  const sameValue = value === node.value;
  const sameK = JSON.stringify(gWin) === JSON.stringify(node.winning);
  const sameDepth = depth === node.depth && cf + slow === node.depth;
  if (!(sameValue && sameK && sameDepth)) {
    routeDiff++;
    if (routeDiffSamples.length < 5) {
      routeDiffSamples.push(`${node.key}: 穷举 ${node.value}/${node.kStar}/帕${node.depth} vs φ ${value}/${gWin.join(',') || '无'}/帕${depth}(cf${cf}+慢${slow})`);
    }
  }
}
console.log(`[${ms()}s] route2 φ vs route1 grid: ${rec.positions} positions · structural problems ${rec.problems.length} · disagreements ${routeDiff}`);
if (routeDiff) fail('两条路线对同一局面给出不同判定/胜口/深度：' + routeDiffSamples.join(' | '));

// ------------------------------------------------------- 3. the two identities that ARE true
// depth == cfLength + slowSteps (the naive "plies == Euclid divisions" claim is FALSE; see
// DESIGN §3), distinct square sizes == cfLength, total squares == sum of partial quotients.
let depthBad = 0;
let sizeBad = 0;
let countBad = 0;
let insertionExamples = 0;
for (let a = 1; a <= BOOK_BOUND; a++) {
  for (let b = 1; b <= a; b++) {
    const node = grid.get(pairKey(a, b));
    const qs = cfQuotients(a, b);
    if (node.depth !== qs.length + slowSteps(a, b)) depthBad++;
    const sizes = new Set(lineThrough(a, b).map((p) => p.b));
    if (sizes.size !== qs.length) sizeBad++;
    const cut = lineThrough(a, b).reduce((s, p) => s + p.k, 0);
    if (cut !== squareCount(a, b)) countBad++;
    if (node.depth !== qs.length) insertionExamples++;
  }
}
console.log(`[${ms()}s] identities a<=${BOOK_BOUND}: depth==cf+slow bad ${depthBad} · #sizes==cfLength bad ${sizeBad} `
  + `· Σk==squareCount bad ${countBad} · positions where plies != divisions ${insertionExamples}/${c60.positions}`);
if (depthBad || sizeBad || countBad) fail('长度恒等式在棋格上不成立，文档里的数字不能发');

// ------------------------------------------------------- 4. the uniqueness census, wider than the book
let uniquePairs = 0;
let uniqueViolations = 0;
const uniqueSamples = [];
for (let a = 1; a <= UNIQUE_MAXA; a++) {
  for (let b = 1; b < a; b++) {
    uniquePairs++;
    const wins = gWinningMoves(a, b);
    if (wins.length > 1) {
      uniqueViolations++;
      if (uniqueSamples.length < 5) uniqueSamples.push(`${pairKey(a, b)} -> ${wins.join(',')}`);
    }
  }
}
console.log(`[${ms()}s] uniqueness census 1<=b<a<=${UNIQUE_MAXA}: ${uniquePairs} pairs · >=2 winning moves ${uniqueViolations}`);
if (uniqueViolations) fail('胜利不唯一：' + uniqueSamples.join(' | '));

// ------------------------------------------------------- 5. the φ sweep: the widest check there is
const phi = phiCensus(PHI_MAXA, { solve });
const phiPairs = (PHI_MAXA * (PHI_MAXA + 1)) / 2;
console.log(`[${ms()}s] two-route sweep 1<=b<=a<=${PHI_MAXA}: ${phi.pairs} pairs (= ${phiPairs}) · agree ${phi.agree} · disagree ${phi.disagreements}`);
if (phi.pairs !== phiPairs) fail(`配对数 ${phi.pairs} != ${PHI_MAXA}*(${PHI_MAXA}+1)/2`);
if (phi.disagreements) fail('两条路线在更大范围分叉：' + phi.disagree.join(' | '));

// ------------------------------------------------------- 6. Lamé, measured
// The theorem's hypothesis is a > b > 0, so the scan is strict: (1,1) needs one division too, and
// letting it in would "disprove" Lamé with a degenerate square instead of measuring anything.
const lame = [];
for (let n = 1; n <= 9; n++) {
  let best = null;
  for (let a = 2; a <= 200; a++) {
    for (let b = 1; b < a; b++) {
      if (cfLength(a, b) !== n) continue;
      if (!best || a < best.a || (a === best.a && b < best.b)) best = { a, b };
    }
  }
  const f1 = fibOf(n + 2);
  const f2 = fibOf(n + 1);
  lame.push({ n, min: best ? `${best.a}:${best.b}` : null, fibonacci: `${f1}:${f2}`, ok: !!best && best.a === f1 && best.b === f2 });
  if (!best || best.a !== f1 || best.b !== f2) fail(`Lamé 在 n=${n} 不成立：最小长边 ${best && best.a} != F(${n + 2})=${f1}`);
}
console.log(`[${ms()}s] Lamé (min long side needing n divisions): ${lame.map((r) => `n${r.n}=${r.min}`).join(' ')} · all == (F(n+2),F(n+1)): ${lame.every((r) => r.ok)}`);

// ------------------------------------------------------- 7. the book payload, round-tripped
const book = encodeBook(grid);
const roundTrip = decodeBook(book);
if (roundTrip.size !== book.states) fail(`棋书编码往返丢行 ${roundTrip.size} != ${book.states}`);
for (const node of grid.values()) {
  const hit = roundTrip.get(node.key);
  if (!hit) fail(`棋书缺行 ${node.key}`);
  if (hit.value !== node.value) fail(`棋书与棋格对 ${node.key} 判定相反`);
  if (hit.k !== node.chosen) fail(`棋书与棋格给 ${node.key} 的着法不同（${hit.k} vs ${node.chosen}）`);
  if (hit.depth !== node.depth) fail(`棋书与棋格给 ${node.key} 的帕不同（${hit.depth} vs ${node.depth}）`);
}
if (book.rows[0] !== encodeRow(grid.get('1:1'))) fail('棋书行序不稳定：首行不是 1:1');

// ------------------------------------------------------- 8. the campaign
const lots = [];
const rows = [];
for (const band of BANDS) {
  const cands = candidates(band);
  const reasons = {};
  const eligible = [];
  for (const [a, b] of cands) {
    const node = grid.get(pairKey(a, b));
    if (!node) fail(`档位 ${band.key} 的 ${a}:${b} 不在棋格里`);
    if (node.value !== (gIsLoss(a, b) ? 'loss' : 'win')) fail(`${a}:${b} 两路判定分叉，先修模型再烘焙`);
    const analysis = { value: node.value, k: node.chosen, depth: node.depth };
    const gate = eligibility([a, b], analysis, band);
    if (!gate.ok) {
      reasons[gate.why] = (reasons[gate.why] || 0) + 1;
      continue;
    }
    eligible.push({
      key: node.key,
      ...lotStats([a, b], analysis),
      margin: margin(a, b),
      ratio: ratioText(a, b, 4),
      winner: '先手',
      outcome: '先手必胜',
      divisions: cfLength(a, b),
      slow: slowSteps(a, b),
      squares: squareCount(a, b),
      legal: legalMoves(a, b).length,
    });
  }
  if (!eligible.length) fail(`档位 ${band.key} 一题都不合格，参数写错了`);
  const picked = curate(eligible, PER_BAND);
  picked.forEach((lot, i) => {
    lots.push({
      id: `${band.key}-${String(i + 1).padStart(2, '0')}`,
      tier: band.key,
      a: lot.a,
      b: lot.b,
      g: lot.g,
      q: lot.q,
      r: lot.r,
      legal: lot.legal,
      k: lot.k,
      depth: lot.depth,
      chance: lot.chance,
      margin: lot.margin,
      ratio: lot.ratio,
      area: lot.area,
      divisions: lot.divisions,
      slow: lot.slow,
      squares: lot.squares,
      winner: lot.winner,
      label: `${lot.a}×${lot.b}`,
    });
  });
  const depths = eligible.map((e) => e.depth);
  rows.push({
    band: band.key,
    label: band.label,
    cands: cands.length,
    eligible: eligible.length,
    eligiblePct: Number(((100 * eligible.length) / cands.length).toFixed(1)),
    shipped: picked.length,
    acceptPct: Number(((100 * picked.length) / cands.length).toFixed(1)),
    reasons,
    qRange: [Math.min(...eligible.map((e) => e.q)), Math.max(...eligible.map((e) => e.q))],
    depthRange: [Math.min(...depths), Math.max(...depths)],
    marginRange: [Math.min(...eligible.map((e) => e.margin)), Math.max(...eligible.map((e) => e.margin))],
  });
}
if (new Set(lots.map((l) => `${l.a}:${l.b}`)).size !== lots.length) fail('档位之间出现了重复矩形');

// ------------------------------------------------------- 9. per-band meta for the shell
const meta = BANDS.map((band) => {
  const mine = lots.filter((l) => l.tier === band.key);
  const row = rows.find((r) => r.band === band.key);
  return {
    key: band.key,
    label: band.label,
    rows: band.rows,
    bounds: { minA: band.minA, maxA: band.maxA },
    blurb: band.blurb,
    lots: mine.length,
    cands: row.cands,
    eligible: row.eligible,
    eligiblePct: row.eligiblePct,
    acceptPct: row.acceptPct,
    reasons: row.reasons,
    kMin: Math.min(...mine.map((l) => l.k)),
    kMax: Math.max(...mine.map((l) => l.k)),
    depthMin: Math.min(...mine.map((l) => l.depth)),
    depthMax: Math.max(...mine.map((l) => l.depth)),
    qMin: Math.min(...mine.map((l) => l.q)),
    qMax: Math.max(...mine.map((l) => l.q)),
    chanceMin: Math.min(...mine.map((l) => l.chance)),
    chanceMax: Math.max(...mine.map((l) => l.chance)),
    bound: BOOK_BOUND,
  };
});

// ------------------------------------------------------- 10. write
const lines = [
  '// Generated by tools/bake.mjs — the numbers in this game are measurements, not opinions.',
  `// Bound a<=${BOOK_BOUND}, ${book.states} rows, both routes reconciled state-for-state before this`,
  '// file was written; the bake refuses to ship on disagreement. Re-derive with',
  '// `node tools/bake.mjs`, audit with `node test/book.test.mjs` and `node test/bake.test.mjs`.',
  'export const SCHEMA = ' + JSON.stringify(SCHEMA) + ';',
  'export const BAKED_AT = ' + JSON.stringify(new Date().toISOString()) + ';',
  '// BOOK: the exhaustive retrograde table of every rectangle the game can display, one row per',
  '// position: `<a>:<b>:<value>/<k>/<depth>` with value in {win, loss}, k the cut perfect play',
  '// makes, depth = 帕 = plies left. js/core/book.js looks things up here and THROWS outside the',
  '// bound; nothing in the browser solves.',
  'export const BOOK = ' + JSON.stringify(book) + ';',
  '// Per-band census: how many rectangles the band contains, how many cleared the gates in',
  '// js/core/make.js (eligibility: win AND gcd=1 AND q>=2 AND 帕>=3), the rejection tally by gate,',
  '// and how many this bake shipped. Both percentages are exact fractions of a full enumeration.',
  'export const TIERS_META = ' + JSON.stringify(meta) + ';',
  '// LOTS: one row per puzzle. Every number here is re-derived from BOOK by position before the',
  '// file is written (tools/bake.mjs) and again in the browser (js/core/library.js derive()).',
  '// `q` = floor(a/b) = how many cuts to tell apart, `k` = the unique winning cut, `chance` = 1/q',
  '// = the exact probability that a uniformly random legal cut wins, `margin` = a^2-ab-b^2 = the',
  '// signed integer distance from φ, `depth` = 帕, `divisions`/`slow` = why 帕 is what it is.',
  'export const LOTS = [',
  ...lots.map((l) => '  ' + JSON.stringify(l) + ','),
  '];',
  '// The `#/daily` draw pool: ids the date seed may pick. Kept explicit so a re-bake that changes',
  '// the pool changes the daily for everybody, loudly.',
  'export const DAILY_IDS = ' + JSON.stringify(lots.map((l) => l.id)) + ';',
  '',
];
const body = lines.join('\n');
const outPath = join(root, 'js', 'data', 'lots.js');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);

console.log(`[${ms()}s] wrote ${lots.length} lots (${rows.map((r) => `${r.band}:${r.shipped}`).join(' ')}) -> js/data/lots.js`);
for (const r of rows) {
  console.log(`${r.band}: candidates ${r.cands} (full census) · eligible ${r.eligible} (${r.eligiblePct}%) · shipped ${r.shipped} (${r.acceptPct}% of census) · reject ${JSON.stringify(r.reasons)} · q ${r.qRange.join('-')} · 帕 ${r.depthRange.join('-')} · margin ${r.marginRange.join('-')}`);
}
const deepest = lots.reduce((m, l) => (l.depth > m.depth ? l : m), lots[0]);
console.log(`campaign deepest: ${deepest.label} 帕${deepest.depth} (k=${deepest.k}, q=${deepest.q}) · book deepest: 帕${c60.maxDepth} at ${c60.argmax[0]} (${c60.argmax.length} positions)`);
console.log(`file: ${(Buffer.byteLength(body) / 1024).toFixed(1)} kB · rows ${book.states} (${book.win} win / ${book.loss} loss) · φ sweep ${phi.pairs} pairs`);

function fibOf(n) {
  let p = 1;
  let q = 1;
  for (let i = 3; i <= n; i++) {
    const t = p + q;
    p = q;
    q = t;
  }
  return n <= 2 ? 1 : q;
}
