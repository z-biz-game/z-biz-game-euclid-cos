// The bands and the eligibility rule — what a rectangle has to be before it may become a lot.
//
// Euclid is an impartial two-player game, so there is no "solution length" to print as a dial:
// the position is either a win for the mover or it is not, and — this is the theorem that shapes
// the whole game (js/core/golden.js, Theorem B) — a win has EXACTLY ONE winning move. So `k`
// cannot be the difficulty dial the way chomp's winning-bite count is: it is 1 everywhere the
// player can win at all. The dial here is instead
//
//   q       = floor(a/b) = how many values of k the player must tell apart (the width of the choice)
//   chance  = 1/q        = the exact probability that a uniformly random legal cut wins
//   depth   = par        = plies the game lasts if both seats play the table
//   margin  = a^2-ab-b^2 = the SIGNED integer distance from the golden line, i.e. how close the
//             rectangle is to the 1:phi boundary that decides the verdict
//
// A lot card prints all four, so "hard" is never a string: `nugget` bands are wide-q, shallow
// games, `master` is thin-q and deep.
//
// Size caps: the shipped book is the grid {1 <= b <= a <= 60} (1830 rows), so no band may reach
// past a = 60. The four bands are DISJOINT SLICES of that range (2–14, 15–22, 23–34, 35–60), which
// is what keeps the campaign from showing the same rectangle twice: eligibility also requires
// gcd(a,b)=1, so a position belongs to exactly one band and a re-bake cannot quietly duplicate a
// lot. Bands below 60 exist because DIFFICULTY is not monotone in size — a 60x37 bar has q = 1 and
// is a one-move affair, while a 41x29 bar has q = 1 too but lasts 8 plies.

import { checkPair, gcd, quotient, remainder } from './euclid.js';

export const BOOK_BOUND = 60;

export const BANDS = [
  {
    key: 'nugget', label: '碎金', minA: 2, maxA: 14, rows: '长边 2–14',
    blurb: '入门：口数多、局数短，切错一口立刻看得见',
  },
  {
    key: 'vein', label: '矿脉', minA: 15, maxA: 22, rows: '长边 15–22',
    blurb: '长条开始变扁，φ 判据第一次真的被用到',
  },
  {
    key: 'crucible', label: '坩埚', minA: 23, maxA: 34, rows: '长边 23–34',
    blurb: '中段：帕数 5 起，前两手都在黄金分割线两侧试探',
  },
  {
    key: 'master', label: '大铸', minA: 35, maxA: 60, rows: '长边 35–60',
    blurb: '本仓上限：a ≤ 60 的深局，棋书仍逐位可复算（1830 行）',
  },
];

export const bandByKey = (key) => BANDS.find((b) => b.key === key) || null;

// Candidates: every rectangle inside a band, enumerated exhaustively — no sampling, so the
// acceptance figure the bake prints is a census rather than an estimate. b < a: the square is one
// cut and no decision, so it is not a candidate for anything (it is still in the BOOK, because the
// table has to answer it).
export function candidates(band) {
  if (!band || !Number.isInteger(band.maxA) || !Number.isInteger(band.minA)) {
    throw new TypeError('candidates: 需要带 minA/maxA 的档位');
  }
  const out = [];
  for (let a = band.minA; a <= band.maxA; a++) {
    for (let b = 1; b < a; b++) out.push([a, b]);
  }
  return out;
}

// A candidate becomes a lot only if it clears every gate below. `why` names the gate that
// rejected it, and the bake prints the full tally, so the acceptance rate can be audited rather
// than believed. This is the exact shipping criterion of this repo:
//
//   inside-book  a <= BOOK_BOUND, else the book would throw on it
//   coprime      gcd(a,b) = 1: a 12x8 bar IS a scaled 3x2 bar, and shipping both would be
//                shipping one puzzle twice under two labels
//   win          the mover wins. A lot the player cannot win is not a puzzle, it is a lecture
//   q >= 2       at least two k to tell apart = "not trivially forced". q = 1 positions have
//                exactly one legal move, so the player cannot lose and cannot choose either
//   depth >= 3   the game must last at least three plies, else "find the win" is "cut, done"
export function eligibility(pair, analysis, band) {
  let x;
  let y;
  try {
    [x, y] = checkPair(pair[0], pair[1]);
  } catch (err) {
    return { ok: false, why: 'invalid' };
  }
  if (!analysis || !analysis.value) return { ok: false, why: 'no-analysis' };
  if (x > BOOK_BOUND) return { ok: false, why: 'outside-book' };
  if (band && x > band.maxA) return { ok: false, why: 'outside-band' };
  if (x === y) return { ok: false, why: 'square' };
  if (gcd(x, y) !== 1) return { ok: false, why: 'not-coprime' };
  if (analysis.value !== 'win') return { ok: false, why: 'loss' };
  if (quotient(x, y) < 2) return { ok: false, why: 'fewChoices' };
  if (!(analysis.depth >= 3)) return { ok: false, why: 'shallow' };
  return { ok: true, pair: [x, y], q: quotient(x, y), legal: quotient(x, y), k: analysis.k, depth: analysis.depth };
}

// The curation rule: rank the eligible positions hardest-first (deepest par, then widest choice,
// then smallest numbers so a band does not start with the same rectangle it just showed), then
// sample at even rank intervals. Deterministic by construction — `node tools/bake.mjs` twice must
// produce the same bytes — and deliberately NOT a seeded draw, because a seeded draw would make
// the shipped pool depend on a constant nobody can justify.
export const PER_BAND = 8;

export function rankHard(eligible) {
  return eligible.slice().sort((p, r) => (r.depth - p.depth)
    || (r.q - p.q)
    || (p.a - r.a)
    || (p.b - r.b)
    || (p.key < r.key ? -1 : 1));
}

export function curate(eligible, count = PER_BAND) {
  const ranked = rankHard(eligible);
  if (ranked.length === 0) return [];
  const picked = new Set();
  for (let i = 0; i < Math.min(count, ranked.length); i++) {
    let idx = ranked.length === 1 ? 0 : Math.round((i * (ranked.length - 1)) / (Math.min(count, ranked.length) - 1));
    while (picked.has(idx)) idx = (idx + 1) % ranked.length;
    picked.add(idx);
  }
  return [...picked].sort((m, n) => m - n).map((i) => ranked[i]);
}

// The four numbers a lot card prints, from a pair and its analysis. Kept in one place so the
// bake, the shell and the tests cannot disagree about what `chance` means: it is 1/legal, the
// exact probability that a uniformly random legal cut wins the game from here.
export function lotStats(pair, analysis) {
  const [x, y] = checkPair(pair[0], pair[1]);
  const q = quotient(x, y);
  return {
    a: x,
    b: y,
    g: gcd(x, y),
    q,
    r: remainder(x, y),
    legal: q,
    k: analysis.k,
    depth: analysis.depth,
    chance: Number((1 / q).toFixed(6)),
    area: x * y,
  };
}
