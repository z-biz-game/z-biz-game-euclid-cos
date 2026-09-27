// The pool API: everything the shell asks about "which lot is this / what does its card print /
// is the shipped number still true". Pure — it reads js/data/lots.js and the book, and never
// searches. The re-derivation in `verifyLot` is book lookups only, which is what lets the browser
// run the same audit the build ran, and it is the reason a hand-edited js/data/lots.js fails
// `npm run unit` instead of shipping.
//
// The contract this file exists to enforce: a lot's printed verdict (先手必胜), its unique winning
// cut `k`, its par (帕 = depth), its choice width q and its chance 1/q are ALL read back out of the
// baked table by position, so no card can carry a number the opponent would not play.

import { BOOK, DAILY_IDS, LOTS, SCHEMA, BAKED_AT, TIERS_META } from '../data/lots.js';
import { decodeBook, lookup } from './book.js';
import { checkPair, gcd, legalMoves, margin, pairKey, quotient, ratioText } from './euclid.js';
import { BANDS, BOOK_BOUND, bandByKey, candidates, curate, eligibility, lotStats } from './make.js';
import { hashSeed, mulberry32 } from './rng.js';

let map = null;

export function bookMap() {
  if (!map) map = decodeBook(BOOK);
  return map;
}

export const SCHEMA_ID = SCHEMA;
export const BAKED_AT_ISO = BAKED_AT;
export const BOOK_BOUND_SHIPPED = BOOK.bound;

export const lots = LOTS;
export const tiers = TIERS_META;
export const tierKeys = TIERS_META.map((t) => t.key);

export function lotById(id) {
  return LOTS.find((l) => l.id === id) || null;
}

export function lotsByTier(key) {
  return LOTS.filter((l) => l.tier === key);
}

// The campaign order `#/c/<n>`: band by band, and inside a band easiest first — shortest par
// first, then the narrowest choice (q ascending), then the smaller numbers. Every lot in it is a
// win for the mover with q >= 2 and par >= 3 by construction (js/core/make.js `eligibility`), so
// no step of the campaign is a coin flip or a lecture.
let campaignCache = null;
export function campaign() {
  if (campaignCache) return campaignCache;
  const order = new Map(TIERS_META.map((t, i) => [t.key, i]));
  campaignCache = LOTS.slice().sort((p, r) => ((order.get(p.tier) ?? 99) - (order.get(r.tier) ?? 99))
    || (p.depth - r.depth)
    || (p.q - r.q)
    || (p.a - r.a)
    || (p.b - r.b));
  return campaignCache;
}

export function lotAt(index /* 1-based */) {
  const list = campaign();
  const n = Number(index);
  if (!Number.isInteger(n) || n < 1 || n > list.length) return null;
  return list[n - 1];
}

export function poolStats() {
  return {
    lots: LOTS.length,
    byTier: Object.fromEntries(TIERS_META.map((t) => [t.key, lotsByTier(t.key).length])),
    bound: BOOK.bound,
    states: BOOK.states,
    win: BOOK.win,
    loss: BOOK.loss,
    bakedAt: BAKED_AT,
    schema: SCHEMA,
  };
}

// The numbers a lot card prints, re-derived from the pair by TABLE LOOKUP only. Used by the shell
// (so a card cannot print a number that disagrees with the book) and by test/library.test.mjs.
export function derive(lot) {
  const [a, b] = checkPair(lot.a, lot.b);
  const row = lookup(bookMap(), a, b);
  const q = quotient(a, b);
  return {
    key: pairKey(a, b),
    a,
    b,
    value: row.value,
    winner: row.value === 'win' ? '先手' : '后手',
    k: row.k,
    depth: row.depth,
    q,
    legal: legalMoves(a, b).length,
    chance: Number((1 / q).toFixed(6)),
    margin: margin(a, b),
    ratio: ratioText(a, b, 4),
    g: gcd(a, b),
    area: a * b,
  };
}

export function verifyLot(lot) {
  const bad = [];
  let r;
  try {
    r = derive(lot);
  } catch (err) {
    return [`无法从棋书判定这关：${err.message}`];
  }
  if (r.g !== 1) bad.push(`gcd=${r.g}，本仓只出既约矩形（${r.a}×${r.b} 与缩比后是同一局）`);
  if (r.a > BOOK_BOUND) bad.push(`a=${r.a} 越出棋书边界 ${BOOK_BOUND}`);
  if (lot.winner !== '先手') bad.push('winner 必须是先手（本仓只出先手必胜的题）');
  if (r.winner !== lot.winner) bad.push(`印着的 winner=${lot.winner} 与棋书 ${r.winner} 不一致`);
  if (r.k !== lot.k) bad.push(`印着的 k=${lot.k} 与棋书 ${r.k} 不一致`);
  if (r.depth !== lot.depth) bad.push(`印着的 depth=${lot.depth} 与棋书 帕=${r.depth} 不一致`);
  if (r.q !== lot.q || lot.legal !== r.legal) bad.push(`q/legal ${lot.q}/${lot.legal} != 棋书 ${r.q}/${r.legal}`);
  if (lot.chance !== r.chance) bad.push(`chance ${lot.chance} != 1/q=${r.chance}`);
  if (lot.area !== r.area) bad.push(`area ${lot.area} != ${r.area}`);
  if (lot.ratio !== r.ratio) bad.push(`ratio ${lot.ratio} != 长除 ${r.ratio}`);
  if (lot.margin !== r.margin) bad.push(`margin ${lot.margin} != ${r.margin}`);
  if (!TIERS_META.some((t) => t.key === lot.tier)) bad.push('未知档位 ' + lot.tier);
  const band = bandByKey(lot.tier);
  if (band && (r.a < band.minA || r.a > band.maxA)) bad.push(`${r.a}×${r.b} 不在档位 ${band.key} 的 ${band.minA}–${band.maxA} 内`);
  return bad;
}

export function verifyPool() {
  const problems = [];
  const seen = new Set();
  for (const lot of LOTS) {
    if (seen.has(lot.id)) problems.push(`重复 id ${lot.id}`);
    seen.add(lot.id);
    for (const p of verifyLot(lot)) problems.push(`${lot.id}: ${p}`);
  }
  const triangle = (BOOK.bound * (BOOK.bound + 1)) / 2;
  if (BOOK.rows.length !== triangle) problems.push(`book rows ${BOOK.rows.length} != 三角 ${triangle}`);
  if (BOOK.states !== BOOK.rows.length) problems.push(`book states ${BOOK.states} != rows ${BOOK.rows.length}`);
  let win = 0;
  let loss = 0;
  for (const line of BOOK.rows) {
    if (line.includes(':win/')) win++;
    else loss++;
  }
  if (win !== BOOK.win) problems.push(`book win ${win} != declared ${BOOK.win}`);
  if (loss !== BOOK.loss) problems.push(`book loss ${loss} != declared ${BOOK.loss}`);
  return problems;
}

// `#/daily`: the date string is the seed, so every device on the same calendar day draws the same
// rectangle. Selection is a bounded index into a baked list — no generation, no search.
export function dailyLot(dateKey) {
  const key = String(dateKey || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new RangeError('dailyLot: 需要 YYYY-MM-DD，收到 ' + JSON.stringify(key));
  const ids = DAILY_IDS.length ? DAILY_IDS : LOTS.map((l) => l.id);
  const rng = mulberry32(hashSeed('euclid-daily:' + key));
  const id = ids[rng.int(ids.length)];
  const base = lotById(id);
  if (!base) throw new Error('daily 指向了一个不存在的题 ' + id);
  const r = derive(base);
  return {
    ...base,
    id: `daily-${key}`,
    sourceId: base.id,
    mode: 'daily',
    day: key,
    label: `每日金条 · ${key}`,
    k: r.k,
    depth: r.depth,
    chance: r.chance,
  };
}

// `#/random/<tier>/<seed>`: a stable rectangle per (tier, seed) inside the baked pool.
export function randomLot(seed, tierKey) {
  const pool = tierKey && tierKeys.includes(tierKey) ? lotsByTier(tierKey) : LOTS;
  const rng = mulberry32(hashSeed(`euclid-random:${tierKey || 'any'}:${String(seed)}`));
  const base = pool[rng.int(pool.length)];
  const r = derive(base);
  return {
    ...base,
    id: `random-${tierKey || 'any'}-${String(seed)}`,
    sourceId: base.id,
    mode: 'random',
    k: r.k,
    depth: r.depth,
    chance: r.chance,
  };
}

export function tierMeta(key) {
  return TIERS_META.find((t) => t.key === key) || null;
}

// The band machinery, re-exported so the shell and the tests ask one thing for the rules of the
// pool. `eligibility`/`curate`/`candidates` are the bake's own functions: if a shipped lot ever
// failed them, `test/library.test.mjs` would say so.
export { BANDS, BOOK_BOUND, bandByKey, candidates, curate, eligibility, lotStats };
