// Route 1 — exhaustive retrograde analysis over the pair grid. This file answers "who wins" by
// ENUMERATING, never by quoting a theorem: it is the ground truth the φ test is checked against,
// and it is written so that a reader can see the recursion rather than believe it.
//
// Why exhaustive is cheap here (and why it is NOT a live search behind a tap):
//   * a move replaces a by a - k*b with k >= 1, so the LONG side strictly decreases. Ordering the
//     grid by ascending a therefore makes every successor already classified: `table(maxA)` is one
//     bottom-up sweep with no recursion, no visited set and no depth limit. Measured on this
//     machine: the full 1830-row sweep for the shipped bound 60 takes 4-15 ms, and a warm
//     `solve()` lookup takes 0.003 ms. Neither number is why the browser ships a table — the
//     browser ships a table because a baked table cannot disagree with the bake that produced it.
//
// Outcome convention:
//   'win'  (N) — the player to move can force a win.
//   'loss' (P) — under perfect play the player to move LOSES.
//   There is no pass: with a >= b >= 1 the quotient is always >= 1, so a position with no move
//   never appears on the board. Reaching a multiple is not "the opponent cannot move", it is
//   "the mover tiled the rectangle and wins on the spot" — the same convention js/core/game.js
//   bills plies with, and the one place a wrong choice would silently flip every verdict.
//
// depth = plies the game still lasts under perfect play. The winner has exactly one move to a
// loss (Theorem B, verified by census in js/core/golden.js and test/golden.test.mjs), and a loser
// has exactly ONE legal move at all (a loss always sits at 1 < a/b < phi, hence quotient 1), so
// "maximally resistant" and "the only move" are the same line and depth is a property of the
// position rather than of a policy. Both uniqueness claims are asserted over the whole grid.

import { checkPair, legalMoves, pairKey, parsePairKey, quotient, successor } from './euclid.js';

const memo = new Map();

// One position, memoised over strictly smaller long sides.
// Returns { key, a, b, value, moves, winning, kStar, successor, legal, depth }.
export function solve(a, b) {
  const [x, y] = checkPair(a, b);
  const key = pairKey(x, y);
  const hit = memo.get(key);
  if (hit) return hit;
  const moves = legalMoves(x, y);
  const winning = [];
  const children = [];
  for (const k of moves) {
    const next = successor(x, y, k);
    if (next === null) {
      // Exact tiling: the mover wins immediately, nothing is handed over.
      winning.push(k);
      children.push({ k, key: null, value: 'win', depth: 0 });
      continue;
    }
    const child = solve(next[0], next[1]);
    children.push({ k, key: child.key, value: child.value, depth: child.depth });
    if (child.value === 'loss') winning.push(k);
  }
  const value = winning.length ? 'win' : 'loss';
  let kStar = null;
  let depth;
  if (value === 'win') {
    kStar = winning[0];
    const chosen = children.find((c) => c.k === kStar);
    depth = 1 + chosen.depth;
  } else {
    // Lost already: every move gives the opponent a win, so the table plays the longest one.
    depth = 1 + Math.max(...children.map((c) => c.depth));
  }
  const chosenKey = value === 'win'
    ? children.find((c) => c.k === kStar).key
    : null;
  const node = {
    key, a: x, b: y, value, moves, winning, kStar,
    legal: moves.length,
    successor: chosenKey ?? null,
    depth,
  };
  memo.set(key, node);
  return node;
}

export function isWin(a, b) {
  return solve(a, b).value === 'win';
}
export function isLoss(a, b) {
  return solve(a, b).value === 'loss';
}
export function depth(a, b) {
  return solve(a, b).depth;
}
export function winningMoves(a, b) {
  return solve(a, b).winning.slice();
}

// The forced line under perfect play, from the position to the exact tiling. Both seats' moves
// come out of the table, so the shell and the tests can replay a whole game without guessing.
export function lineThrough(a, b) {
  const line = [];
  let cur = solve(a, b);
  let seat = 'you';
  let guard = 0;
  while (guard++ < 4000) {
    const k = cur.value === 'win' ? cur.kStar : cur.moves[0];
    if (k === undefined) throw new Error(`lineThrough: ${cur.key} 是必败局却有 ${cur.legal} 个口`);
    const next = successor(cur.a, cur.b, k);
    line.push({ seat, a: cur.a, b: cur.b, k, exact: next === null, quotient: quotient(cur.a, cur.b) });
    if (next === null) break;
    cur = solve(next[0], next[1]);
    seat = seat === 'you' ? 'ai' : 'you';
  }
  if (guard >= 4000) throw new Error('lineThrough: 线路没有收敛，模型有环');
  return line;
}

// ------------------------------------------------------------------ the grid
// One bottom-up sweep over 1 <= b <= a <= maxA: a successor always has a smaller long side, so
// ascending `a` classifies everything before it is consulted. Same convention as `solve` above,
// reached by a different control flow — which is the point of having two.
export function table(maxA) {
  if (!Number.isInteger(maxA) || maxA < 1) throw new RangeError('table: maxA 需要正整数');
  const grid = new Map();
  for (let a = 1; a <= maxA; a++) {
    for (let b = 1; b <= a; b++) {
      const key = pairKey(a, b);
      const moves = legalMoves(a, b);
      const winning = [];
      const childDepth = new Map();
      for (const k of moves) {
        const next = successor(a, b, k);
        if (next === null) {
          winning.push(k);
          childDepth.set(k, 0);
          continue;
        }
        const ck = pairKey(next[0], next[1]);
        const child = grid.get(ck);
        if (!child) throw new Error(`table: 后继 ${ck} 跑到了网格外（a 没有单调下降？）`);
        childDepth.set(k, child.depth);
        if (child.value === 'loss') winning.push(k);
      }
      const value = winning.length ? 'win' : 'loss';
      const kStar = winning.length ? winning[0] : null;
      // The move this table would play: the unique winning move, or (already lost) the one that
      // keeps the game longest. The loser's longest line is also often its ONLY line — asserted
      // over the whole grid by census().lossWithChoice === 0.
      let chosen = kStar;
      let depth = 0;
      if (value === 'win') {
        depth = 1 + childDepth.get(kStar);
      } else {
        depth = -1;
        for (const k of moves) {
          const d = 1 + childDepth.get(k);
          if (d > depth) {
            depth = d;
            chosen = k;
          }
        }
      }
      const next = successor(a, b, chosen);
      grid.set(key, {
        key, a, b, value, moves, winning, kStar,
        legal: moves.length,
        chosen,
        successor: next === null ? null : pairKey(next[0], next[1]),
        depth,
      });
    }
  }
  return grid;
}

export function resetMemo() {
  memo.clear();
}

// ------------------------------------------------------------------ the census
// The measured facts README and DESIGN quote. Everything here is a full enumeration over the
// grid, not a sample, so each number is an exact count.
export function census(maxA, opts = {}) {
  const grid = opts.grid || table(maxA);
  const out = {
    maxA,
    positions: 0,
    win: 0,
    loss: 0,
    multiWinning: 0,   // positions with >= 2 winning moves — Theorem B says 0
    noWinning: 0,      // positions with 0 winning moves — must equal `loss`
    lossWithChoice: 0, // loss positions with > 1 legal move — Theorem A says 0
    marginZero: 0,     // positions with a^2 == ab + b^2 — impossible for integers
    squares: 0,        // a == b: the one-square tiling, always an immediate win
    disagreements: 0,  // bottom-up vs memoised recursion (only counted when crossCheck is on)
    maxDepth: 0,
    argmax: [],
    depthHist: {},
    widestChoice: 0,
  };
  for (const node of grid.values()) {
    out.positions++;
    if (node.value === 'win') out.win++;
    else out.loss++;
    if (node.winning.length > 1) out.multiWinning++;
    if (node.winning.length === 0) out.noWinning++;
    if (node.value === 'loss' && node.legal > 1) out.lossWithChoice++;
    const m = node.a * node.a - node.a * node.b - node.b * node.b;
    if (m === 0) out.marginZero++;
    if (node.a === node.b) out.squares++;
    if (node.legal > out.widestChoice) out.widestChoice = node.legal;
    out.depthHist[node.depth] = (out.depthHist[node.depth] || 0) + 1;
    if (node.depth > out.maxDepth) {
      out.maxDepth = node.depth;
      out.argmax = [node.key];
    } else if (node.depth === out.maxDepth) out.argmax.push(node.key);
    if (opts.crossCheck) {
      const viaRecursion = solve(node.a, node.b);
      if (viaRecursion.value !== node.value || viaRecursion.depth !== node.depth) out.disagreements++;
    }
  }
  out.argmax.sort();
  return out;
}

// Look a key up without building anything (used by tests that want the DP answer for one pair).
export function solveKey(key) {
  const [a, b] = parsePairKey(key);
  return solve(a, b);
}
