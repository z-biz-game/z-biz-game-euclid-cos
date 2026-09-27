// A THIRD implementation, written to share no line of logic with either shipped route: its own
// re-typed move rule, plain recursion, and NO memo anywhere — the game tree is re-walked from
// scratch at every node. js/core/retro.js reaches the same answer by a bottom-up sweep over the
// grid, js/core/golden.js by an integer inequality about phi; this one only enumerates.
//
// Why a third one is worth the CPU: two implementations that agree can still share a wrong
// assumption, but three that agree *by different control flow* (bottom-up DP / algebra / raw
// recursion with no cache) is the closest thing this repo has to independent evidence that the
// shipped 1830-row book says what the rules say. test/retro.test.mjs sweeps it against both routes.
//
// Cost: with no memo the tree re-expands, so this is bounded by a node budget rather than by a
// clever recurrence. The budget is a constructor argument, the sweep reports how many positions it
// classified and how many it refused, and the test asserts both counts — an unbounded silent
// fallback would turn "verified" into "sampled", which is the one thing this file must not become.
//
// Conventions identical to js/core/retro.js on purpose (a difference here would be a bug, not
// independence): 'win' = the mover forces a win; a cut with a - k*b = 0 tiles the bar and wins ON
// THE SPOT (depth 1, nothing handed over); the winner's depth is the smallest over its winning
// moves and a loser's the largest over everything (maximal resistance). Under Theorem B the winner
// has exactly one winning move, so "smallest" and "the one" coincide — that coincidence is itself
// what the sweep checks.

export class NaiveBudget extends Error {}

export function naiveSolve(a, b, opts = {}) {
  const budget = Number.isInteger(opts.budget) ? opts.budget : 300000;
  const x0 = Math.max(a, b);
  const y0 = Math.min(a, b);
  if (!Number.isInteger(x0) || !Number.isInteger(y0) || y0 < 1) {
    throw new RangeError('naiveSolve: 需要正整数边长');
  }
  let nodes = 0;

  function walk(x, y) {
    if (++nodes > budget) throw new NaiveBudget('naive: 节点预算 ' + budget + ' 用尽');
    const q = Math.floor(x / y);
    const winning = [];
    let best = Infinity;
    let worst = 0;
    for (let k = 1; k <= q; k++) {
      const rest = x - k * y;
      if (rest === 0) {
        winning.push(k);
        if (best > 1) best = 1;
        if (worst < 1) worst = 1;
        continue;
      }
      const nx = rest > y ? rest : y;
      const ny = rest > y ? y : rest;
      const child = walk(nx, ny);
      if (1 + child.depth > worst) worst = 1 + child.depth;
      if (child.value === 'loss') {
        winning.push(k);
        if (1 + child.depth < best) best = 1 + child.depth;
      }
    }
    const value = winning.length ? 'win' : 'loss';
    return { value, depth: value === 'win' ? best : worst, winning };
  }

  const out = walk(x0, y0);
  return { value: out.value, depth: out.depth, winning: out.winning, nodes };
}

// How deep this no-memo walker can reach before it starts refusing: used by the sweep to report a
// measured bound instead of pretending the whole grid was covered.
export function naiveMaxSide(ceiling = 64, budget = 300000) {
  let reached = 1;
  for (let a = 1; a <= ceiling; a++) {
    let ok = true;
    for (let b = 1; b <= a; b++) {
      try {
        naiveSolve(a, b, { budget });
      } catch (err) {
        if (!(err instanceof NaiveBudget)) throw err;
        ok = false;
        break;
      }
    }
    if (!ok) break;
    reached = a;
  }
  return reached;
}
