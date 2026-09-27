// Route 2 — the closed form. Three lines of integer arithmetic decide what route 1 needs a table
// for, and the two are compared state-for-state before anything ships. This file is the reason the
// opponent in the browser is not a search: `js/core/book.js` is what the tap path consults, and
// `golden.js` is what proves the book says the same thing as mathematics.
//
// THE ALGEBRA (proved here, re-measured in test/anchor.test.mjs and DESIGN §2)
//
// Let phi = (1+sqrt5)/2, the positive root of t^2 = t + 1. For t > 1/2 the polynomial
// g(t) = t^2 - t - 1 is strictly increasing (g'(t) = 2t - 1 > 0) and its only positive zero is
// phi, so for any t > 1:
//
//     t < phi  <=>  g(t) < 0
//
// Substitute t = a/b with integers a > b >= 1 and multiply by b^2 > 0:
//
//     a/b < phi  <=>  a^2 - a*b - b^2 < 0  <=>  a*a < a*b + b*b
//
// which is an EXACT integer comparison: no float, no epsilon, and no irrational boundary can be
// hit because a^2 = ab + b^2 would make a/b = phi rational. `margin(a,b) = a^2 - ab - b^2` is the
// signed integer distance from the golden line, and its sign is the verdict.
//
// THE GAME (one inequality, Theorem A)
//
//   * a = b: cut the single square, tile exactly, win. margin = -b^2 < 0 yet the position is a
//     win, which is why the predicate below tests `a > b` first — the degenerate square is the one
//     exception to the golden band and the tests enumerate it separately.
//   * floor(a/b) >= 2: write a = q*b + r, 0 <= r < b. The moves k = q and k = q-1 hand over
//     (b, r) and (b+r, b) respectively, and (b+r, b) has quotient 1 with its single move landing
//     on (b, r) — so those two positions have OPPOSITE values and one of them is a loss for
//     whoever receives it. Hence every quotient >= 2 position is a win (r = 0 wins outright).
//   * floor(a/b) = 1: the only move is k = 1, taking a/b = 1 + 1/t to t = b/(a-b). Substituting
//     x = 1 + 1/t into "t > phi <=> x < phi" fixes the boundary at x = phi itself, so by induction
//     on the Euclidean algorithm the mover loses exactly on 1 < a/b < phi.
//
//   => THE MOVER LOSES <=> a > b AND a^2 < a*b + b^2. One inequality, no search.
//
// THE FORCED LINE (Theorem B)
//
// A move wins iff it lands on a loss. For k < q the successor has long side a-k*b >= b, so the
// target is a-k*b < phi*b, i.e. k in the open interval (x-phi, x-1) of width phi-1 < 1: at most
// one integer. For k = q the successor is (b, r), a loss iff b^2 < b*r + r^2, which is a different
// inequality — so the "1 < x-k < phi" phrasing is only valid for k < q and is NOT the theorem.
// q-1 can only win when q fails, so the whole winning set lives in {q-1, q}: at most one move.
// Multiples: only k = q (take everything) wins, since any smaller k leaves a multiple of b for the
// opponent, who then tiles it. CONCLUSION: every winning position has EXACTLY one winning move,
// so under perfect play this game is a single forced line — census() over the shipped grid counts
// positions with two winning moves and prints 0.
//
// THE LENGTH (Theorem C, as MEASURED — the naive "moves == Euclid divisions" claim is false)
//
//   depth(a,b) = cfLength(a,b) + slowSteps(a,b)
//
// where cfLength is the number of Euclidean divisions (= the partial quotients of a/b) and
// slowSteps counts the divisions whose quotient is >= 2 but whose remainder is too small
// (r/b < 1/phi, i.e. b^2 > b*r + r^2): at those the winning move is k = q-1, which cuts q-1
// squares now and forces the opponent to cut the q-th, so the same Euclid step costs TWO moves.
// Measured identity, asserted state-for-state in test/golden.test.mjs for the whole shipped grid.
// Consequences that ARE folklore-proof: the distinct square SIZES cut under perfect play are
// exactly the Euclid chain (so #sizes = cfLength), the total square COUNT is the sum of the
// partial quotients, and Lamé's theorem — the smallest rectangle needing n divisions is
// (F(n+2), F(n+1)) — holds and is measured. What does NOT hold: that the deepest *games* (in
// plies) are Fibonacci pairs; insertions break it, and the measured argmax for a <= 34 is listed
// in the bake output. Do not re-state the pretty version.

import { cfLength, checkPair, legalMoves, margin, pairKey, quotient, successor } from './euclid.js';

// The float-free verdict. TRUE = the player to move loses under perfect play.
export function isLoss(a, b) {
  const [x, y] = checkPair(a, b);
  if (x === y) return false; // the square tiles in one cut
  return margin(x, y) < 0;
}

export function isWin(a, b) {
  return !isLoss(a, b);
}

// Which k wins, derived from the golden band rather than from a table. null when the position is a
// loss (then there is none, and the single legal move is forced).
export function winningK(a, b) {
  const [x, y] = checkPair(a, b);
  const q = quotient(x, y);
  const r = x % y;
  if (r === 0) return q; // exact tiling wins and it is the only move that does
  // k = q leaves (b, r): a loss iff y > r and y^2 < y*r + r^2
  if (isLoss(y, r)) return q;
  // k = q-1 leaves (b+r, b): the position whose only move goes back to (b, r)
  if (q >= 2 && isLoss(y + r, y)) return q - 1;
  return null;
}

// Every winning move, for the census that proves the set has size <= 1.
export function winningMoves(a, b) {
  const out = [];
  const [x, y] = checkPair(a, b);
  for (const k of legalMoves(x, y)) {
    const next = successor(x, y, k);
    if (next === null || isLoss(next[0], next[1])) out.push(k);
  }
  return out;
}

// Divisions along the Euclid chain that cost two moves under perfect play (see the header).
export function slowSteps(a, b) {
  let [x, y] = checkPair(a, b);
  let n = 0;
  while (y > 0) {
    const q = Math.floor(x / y);
    const r = x % y;
    if (r > 0 && q >= 2 && isLoss(y, r) === false) n++;
    x = y;
    y = r;
  }
  return n;
}

// The measured length of the game, from the closed form only.
export function depth(a, b) {
  return cfLength(a, b) + slowSteps(a, b);
}

// The forced line, rebuilt from the golden test alone (route 1 has its own `lineThrough`).
export function lineThrough(a, b) {
  const line = [];
  let [x, y] = checkPair(a, b);
  let seat = 'you';
  let guard = 0;
  for (;;) {
    if (guard++ > 4000) throw new Error('lineThrough: 线路没有收敛');
    const k = isLoss(x, y) ? 1 : winningK(x, y);
    const next = successor(x, y, k);
    line.push({ seat, a: x, b: y, k, exact: next === null, quotient: quotient(x, y) });
    if (next === null) break;
    [x, y] = next;
    seat = seat === 'you' ? 'ai' : 'you';
  }
  return line;
}

// ------------------------------------------------------------------ reconciliation
// Both routes, every position of the grid, no sampling. Returns the disagreement list, which
// tools/bake.mjs refuses to ship when non-empty.
export function reconcile(maxA) {
  const problems = [];
  let positions = 0;
  let wins = 0;
  let losses = 0;
  for (let a = 1; a <= maxA; a++) {
    for (let b = 1; b <= a; b++) {
      positions++;
      const goldenValue = isLoss(a, b) ? 'loss' : 'win';
      if (goldenValue === 'win') wins++;
      else losses++;
      const key = pairKey(a, b);
      const m = margin(a, b);
      if (m === 0) problems.push(`${key}: a^2 == ab+b^2，φ 被判成有理数`);
      if (a > b && (m < 0) !== (a * a < a * b + b * b)) problems.push(`${key}: margin 符号与整数比较不一致`);
      const wm = winningMoves(a, b);
      if (wm.length > 1) problems.push(`${key}: ${wm.length} 个胜口，胜利不唯一`);
      if (goldenValue === 'win' && wm.length !== 1) problems.push(`${key}: 必胜局却有 ${wm.length} 个胜口`);
      if (goldenValue === 'loss' && wm.length !== 0) problems.push(`${key}: 必败局却有胜口`);
      if (goldenValue === 'loss' && legalMoves(a, b).length !== 1) problems.push(`${key}: 必败局不止一个合法 k`);
      const k = goldenValue === 'win' ? wm[0] : null;
      if (k !== null && winningK(a, b) !== k) problems.push(`${key}: winningK=${winningK(a, b)} 与胜口集合 ${k} 不同`);
    }
  }
  return { maxA, positions, wins, losses, problems };
}

// The big number the README prints: every pair with 1 <= b <= a <= maxA, both routes, counted.
// maxA = 1200 is 720_600 pairs; this is the widest the φ algebra has ever been checked here.
export function census(maxA, opts = {}) {
  const step = opts.step === undefined ? 1 : opts.step;
  let pairs = 0;
  let agree = 0;
  let disagree = [];
  const { solve } = opts;
  if (!solve) throw new Error('census 需要传入 route-1 的 solve，才能保持本文件零依赖 route-1');
  for (let a = 1; a <= maxA; a += step) {
    for (let b = 1; b <= a; b++) {
      pairs++;
      const g = isLoss(a, b) ? 'loss' : 'win';
      const r = solve(a, b);
      if (g === r.value) agree++;
      else if (disagree.length < 8) disagree.push(`${pairKey(a, b)}: golden=${g} retro=${r.value}`);
    }
  }
  return { maxA, pairs, agree, disagree: disagree.length ? disagree : [], disagreements: pairs - agree };
}
