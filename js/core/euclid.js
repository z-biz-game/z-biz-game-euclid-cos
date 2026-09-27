// The rule model. No DOM, no window, no randomness, no solver — just the arithmetic the game
// is played on, so `node --test` can import it directly.
//
// A position is a rectangle: integer sides a >= b >= 1. One move picks k with
// 1 <= k <= floor(a/b) and shortens the long side by k squares of side b:
//
//     a -> a - k*b
//
// If a - k*b = 0 the rectangle has just been tiled exactly and the mover WINS on the spot.
// Otherwise the leftovers normalise to (max(b, a-k*b), min(b, a-k*b)) and the opponent moves.
// Normalising is not cosmetic: the rules speak of "the long side", so (7,3) cut with k=2 leaves
// a 3x1 strip, which is the position (3,1) — the same rectangle turned a quarter circle.
//
// Two invariants everything else in the repo is allowed to rely on (test/euclid.test.mjs has a
// negative case for each):
//   * every legal move strictly decreases the long side, so the game always terminates
//     (this is why js/core/retro.js can fill its table bottom-up with no recursion and no
//     visited set);
//   * the position set {1 <= b <= a <= N} is CLOSED under the move relation: a successor never
//     leaves the grid, which is what lets one baked book answer every question the screen asks.
//
// Integer range guard: js/core/golden.js decides win/loss from a*a, a*b and b*b. Those stay
// exact only while 3*a*a < Number.MAX_SAFE_INTEGER, i.e. a <= MAX_EXACT_SIDE below. Anything
// bigger is refused out loud instead of quietly answering with a rounded float.

export const MAX_EXACT_SIDE = Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER / 3)); // 54_794_158

export function validatePair(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return '边长必须是数字';
  if (!Number.isInteger(a) || !Number.isInteger(b)) return `边长 ${a}×${b} 不是整数`;
  if (a < 1 || b < 1) return `边长必须为正（收到 ${a}×${b}）`;
  if (a > MAX_EXACT_SIDE || b > MAX_EXACT_SIDE) return `边长超出整数判据的安全上限 ${MAX_EXACT_SIDE}`;
  return null;
}

// (a, b) with a >= b. Returns a NEW pair; inputs are never mutated.
export function normalise(a, b) {
  const err = validatePair(a, b);
  if (err) throw new RangeError('normalise: ' + err);
  return a >= b ? [a, b] : [b, a];
}

export function checkPair(a, b) {
  const err = validatePair(a, b);
  if (err) throw new RangeError(err);
  return [Math.max(a, b), Math.min(a, b)];
}

export function pairKey(a, b) {
  const [x, y] = checkPair(a, b);
  return x + ':' + y;
}

export function parsePairKey(key) {
  const s = String(key);
  const hit = /^(\d+):(\d+)$/.exec(s);
  if (!hit) throw new TypeError(`parsePairKey: 非法 key ${JSON.stringify(s)}`);
  return checkPair(Number(hit[1]), Number(hit[2]));
}

export function isPair(a, b) {
  if (validatePair(a, b)) return false;
  return a >= b;
}

export const area = (a, b) => a * b;
export const quotient = (a, b) => Math.floor(a / b);
export const remainder = (a, b) => a % b;

// The legal moves of a position, in ascending order: k = 1 .. floor(a/b).
export function legalMoves(a, b) {
  const [x, y] = checkPair(a, b);
  const q = quotient(x, y);
  const out = new Array(q);
  for (let i = 0; i < q; i++) out[i] = i + 1;
  return out;
}

export function isLegalMove(a, b, k) {
  return moveReason(a, b, k) === null;
}

// Why a move is refused, or null when it is legal. Every refusal in the game goes through here,
// so "illegal clicks are never silently swallowed" has exactly one implementation.
export function moveReason(a, b, k) {
  const err = validatePair(a, b);
  if (err) return err;
  const [x, y] = a >= b ? [a, b] : [b, a];
  const q = quotient(x, y);
  if (typeof k !== 'number' || !Number.isInteger(k)) return 'k 不是整数';
  if (k < 1) return '至少要把一块方金切下来（k 必须 >= 1）';
  if (k > q) return `最多只能切 ${q} 块（k=${k} 会把长边切负）`;
  return null;
}

// The successor of a move, or null when the move tiles the rectangle exactly (= immediate win).
export function successor(a, b, k) {
  const reason = moveReason(a, b, k);
  if (reason) throw new RangeError('successor: ' + reason);
  const [x, y] = a >= b ? [a, b] : [b, a];
  const rest = x - k * y;
  if (rest === 0) return null;
  return rest > y ? [rest, y] : [y, rest];
}

export function cutsExactly(a, b, k) {
  const reason = moveReason(a, b, k);
  if (reason) throw new RangeError('cutsExactly: ' + reason);
  return a % b === 0 && k === quotient(a, b);
}

// The geometric blocks a move removes, for the view: k squares of side b, packed from the left.
// `leftover` is the r-wide strip that stays on the bar (width 0 when the cut tiles it exactly).
export function cutBlocks(a, b, k) {
  const reason = moveReason(a, b, k);
  if (reason) throw new RangeError('cutBlocks: ' + reason);
  const [x, y] = a >= b ? [a, b] : [b, a];
  const blocks = [];
  for (let i = 0; i < k; i++) blocks.push({ x: i * y, size: y });
  return { blocks, leftover: x - k * y, side: y };
}

// ------------------------------------------------------------------ the golden quantities
//
// margin(a,b) = a^2 - a*b - b^2. It is the integer shadow of phi: because t^2 - t - 1 has its
// positive root at phi and is strictly increasing for t > 1/2, for a > b >= 1
//
//     a/b < phi  <=>  (a/b)^2 - a/b - 1 < 0  <=>  a^2 - ab - b^2 < 0
//
// so the SIGN of this one integer says who wins (see js/core/golden.js), with no floating point
// anywhere. margin = 0 is impossible for positive integers (that would make a/b rational equal to
// the irrational phi), which the tests assert over a full census.
export function margin(a, b) {
  const [x, y] = checkPair(a, b);
  return x * x - x * y - y * y;
}

export function isSquare(a, b) {
  const [x, y] = checkPair(a, b);
  return x === y;
}

// The continued fraction of a/b as the Euclidean algorithm sees it: the list of partial
// quotients, longest side first. cfQuotients(13,8) = [1,1,1,1,2] — five divisions, and the last
// one is 2 because 2/1 tiles exactly.
export function cfQuotients(a, b) {
  let [x, y] = checkPair(a, b);
  const out = [];
  while (y > 0) {
    out.push(Math.floor(x / y));
    const t = x % y;
    x = y;
    y = t;
  }
  return out;
}

export function cfLength(a, b) {
  return cfQuotients(a, b).length;
}

// How many squares the greedy Euclidean tiling cuts (the sum of the partial quotients). Under
// perfect play the game cuts EXACTLY this many squares of EXACTLY these side lengths, just
// possibly spread over more moves — measured in test/anchor.test.mjs.
export function squareCount(a, b) {
  return cfQuotients(a, b).reduce((s, q) => s + q, 0);
}

// a/b to `digits` decimals by integer long division — the readout prints the ratio without ever
// letting a binary float near the verdict.
export function ratioText(a, b, digits = 4) {
  const [x, y] = checkPair(a, b);
  let rest = x;
  let s = String(Math.floor(rest / y));
  rest %= y;
  if (digits > 0) {
    s += '.';
    for (let i = 0; i < digits; i++) {
      rest *= 10;
      s += String(Math.floor(rest / y));
      rest %= y;
    }
  }
  return s;
}

export const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

// Consecutive Fibonacci pairs, the positions Lamé's theorem singles out. F(1)=1, F(2)=1, F(3)=2…
export function fib(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError('fib: 需要正整数下标');
  let p = 1;
  let q = 1;
  for (let i = 3; i <= n; i++) {
    const t = p + q;
    p = q;
    q = t;
  }
  return n <= 2 ? 1 : q;
}
