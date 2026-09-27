// Hand-computed fixtures. Every expectation in here was worked out ON PAPER, by the argument
// written above it, before any code in this repo ran — that is what makes it a fixture rather than
// a mirror of the implementation. Do not "fix" one of these by running the solver: if it
// disagrees, the solver is wrong.
//
// How each row was derived (the whole game fits in these four lines):
//   * a move from (a,b) with q = floor(a/b) picks k in 1..q and leaves (max(b,a-kb), min(b,a-kb));
//   * k = q with a = q*b tiles the bar exactly: the mover WINS on the spot;
//   * the mover loses exactly when 1 < a/b < phi, i.e. when a^2 < ab + b^2 (for a > b);
//   * depth (帕) = plies left under perfect play. A loser inside the golden band has q = 1, so it
//     has ONE legal move and the line through it is unique: depth = 1 + depth(forced successor). A
//     winner plays its unique winning cut: depth = 1 + depth(the loss it hands over).
//
// Field meanings: v = verdict for the mover, k = the move perfect play makes (the unique winning
// cut; for a loss, the only legal cut), d = depth/帕, cf = Euclid divisions = partial quotients of
// a/b, ins = d - cf (the plies an "insertion" costs: where the winning cut is q-1 rather than q,
// one Euclid step is played out over two moves), m = margin = a^2 - ab - b^2, q = floor(a/b),
// legal = how many k are legal, w = the winning cuts.

export const FIXTURES = [
  // a == b: the degenerate square. margin = -b^2 < 0 yet it is a WIN — this is the one exception
  // to the golden band, which is why js/core/golden.js tests `a > b` before reading the sign.
  { a: 1, b: 1, v: 'win', k: 1, d: 1, cf: 1, ins: 0, m: -1, q: 1, legal: 1, w: [1], why: '1×1 一块切完就铺满' },
  { a: 4, b: 4, v: 'win', k: 1, d: 1, cf: 1, ins: 0, m: -16, q: 1, legal: 1, w: [1], why: '正方形：一块切完，margin<0 却是胜' },
  { a: 2, b: 1, v: 'win', k: 2, d: 1, cf: 1, ins: 0, m: 1, q: 2, legal: 2, w: [2], why: 'k=2 铺满；k=1 交给对手 1×1（那也是铺满）' },
  { a: 3, b: 1, v: 'win', k: 3, d: 1, cf: 1, ins: 0, m: 5, q: 3, legal: 3, w: [3], why: '只有全切才铺满' },
  { a: 4, b: 2, v: 'win', k: 2, d: 1, cf: 1, ins: 0, m: 4, q: 2, legal: 2, w: [2], why: '4=2·2，k=2 铺满；k=1 剩 2×2 让对手铺满' },
  { a: 6, b: 1, v: 'win', k: 6, d: 1, cf: 1, ins: 0, m: 29, q: 6, legal: 6, w: [6], why: '整除：只有全切赢' },
  { a: 5, b: 2, v: 'win', k: 1, d: 3, cf: 2, ins: 1, m: 11, q: 2, legal: 2, w: [1], why: 'k=1→3×2 必败（帕 2）；k=2→2×1 是对手的胜局' },
  { a: 7, b: 3, v: 'win', k: 1, d: 3, cf: 2, ins: 1, m: 19, q: 2, legal: 2, w: [1], why: 'k=1→4×3 必败；k=2→3×1 送对手铺满' },
  { a: 12, b: 5, v: 'win', k: 1, d: 5, cf: 3, ins: 2, m: 59, q: 2, legal: 2, w: [1], why: 'k=1→7×5 必败（帕 4）；k=2→5×2 是对手胜（帕 3）' },
  { a: 11, b: 4, v: 'win', k: 2, d: 3, cf: 3, ins: 0, m: 61, q: 2, legal: 2, w: [2], why: '121>44+16 ⇒ 胜。k=2→4×3 必败；k=1→7×4 则对手胜' },

  // wins above the band with q = 1: the only move still wins, because it hands over a loss.
  { a: 5, b: 3, v: 'win', k: 1, d: 3, cf: 3, ins: 0, m: 1, q: 1, legal: 1, w: [1], why: '25>15+9 ⇒ 胜：k=1→3×2 必败' },
  { a: 9, b: 5, v: 'win', k: 1, d: 3, cf: 3, ins: 0, m: 11, q: 1, legal: 1, w: [1], why: '81>45+25 ⇒ 胜：k=1→5×4 必败（帕 2）' },
  { a: 13, b: 8, v: 'win', k: 1, d: 5, cf: 5, ins: 0, m: 1, q: 1, legal: 1, w: [1], why: '169>104+64 ⇒ 胜：k=1→8×5 必败' },
  { a: 34, b: 21, v: 'win', k: 1, d: 7, cf: 7, ins: 0, m: 1, q: 1, legal: 1, w: [1], why: 'Fibonacci：帕 = 除法数，一次插入都没有' },

  // the golden band: 1 < a/b < phi, so q = 1, so exactly one legal move, and it hands the opponent
  // a win. These are the positions the word 必败 is about.
  { a: 3, b: 2, v: 'loss', k: 1, d: 2, cf: 2, ins: 0, m: -1, q: 1, legal: 1, w: [], why: '9<6+4：只剩 k=1→2×1，对手铺满' },
  { a: 4, b: 3, v: 'loss', k: 1, d: 2, cf: 2, ins: 0, m: -5, q: 1, legal: 1, w: [], why: '16<12+9：k=1→3×1 送对手铺满' },
  { a: 5, b: 4, v: 'loss', k: 1, d: 2, cf: 2, ins: 0, m: -11, q: 1, legal: 1, w: [], why: '25<20+16：k=1→4×1 送对手铺满' },
  { a: 6, b: 4, v: 'loss', k: 1, d: 2, cf: 2, ins: 0, m: -4, q: 1, legal: 1, w: [], why: '6/4=3/2<φ：与 3×2 同一局，只差一个缩放' },
  { a: 7, b: 5, v: 'loss', k: 1, d: 4, cf: 3, ins: 1, m: -11, q: 1, legal: 1, w: [], why: 'k=1→5×2（对手胜，帕 3）⇒ 帕 4' },
  { a: 8, b: 5, v: 'loss', k: 1, d: 4, cf: 4, ins: 0, m: -1, q: 1, legal: 1, w: [], why: '64<40+25：Fibonacci 那一族，没有插入' },
  { a: 9, b: 7, v: 'loss', k: 1, d: 4, cf: 3, ins: 1, m: -31, q: 1, legal: 1, w: [], why: 'k=1→7×2（对手胜，帕 3）⇒ 帕 4；7=3·2+1 那一步被拆成两手' },
  { a: 11, b: 7, v: 'loss', k: 1, d: 4, cf: 4, ins: 0, m: -5, q: 1, legal: 1, w: [], why: '121<77+49 ⇒ 必败；k=1→7×4（对手胜，帕 3）' },
  { a: 13, b: 9, v: 'loss', k: 1, d: 4, cf: 3, ins: 1, m: -29, q: 1, legal: 1, w: [], why: '169<117+81 ⇒ 必败；k=1→9×4，对手胜（帕 3）' },
];

// (F(n+1), F(n)), n = 2..13: the ratios alternate around phi (a Fibonacci convergent overshoots for
// even n and undershoots for odd n), |a^2 - ab - b^2| = 1 for every one of them, and no Euclid step
// has quotient >= 2 until the last, so 帕 == 除法数 exactly — the pure case with no insertions.
export const FIB_LADDER = [
  { n: 2, a: 2, b: 1, v: 'win', d: 1, cf: 1, m: 1 },
  { n: 3, a: 3, b: 2, v: 'loss', d: 2, cf: 2, m: -1 },
  { n: 4, a: 5, b: 3, v: 'win', d: 3, cf: 3, m: 1 },
  { n: 5, a: 8, b: 5, v: 'loss', d: 4, cf: 4, m: -1 },
  { n: 6, a: 13, b: 8, v: 'win', d: 5, cf: 5, m: 1 },
  { n: 7, a: 21, b: 13, v: 'loss', d: 6, cf: 6, m: -1 },
  { n: 8, a: 34, b: 21, v: 'win', d: 7, cf: 7, m: 1 },
  { n: 9, a: 55, b: 34, v: 'loss', d: 8, cf: 8, m: -1 },
  { n: 10, a: 89, b: 55, v: 'win', d: 9, cf: 9, m: 1 },
  { n: 11, a: 144, b: 89, v: 'loss', d: 10, cf: 10, m: -1 },
  { n: 12, a: 233, b: 144, v: 'win', d: 11, cf: 11, m: 1 },
  { n: 13, a: 377, b: 233, v: 'loss', d: 12, cf: 12, m: -1 },
];

// Lamé's theorem, hand-checked: the smallest LONG side whose Euclid chain needs exactly n
// divisions is F(n+2), attained at (F(n+2), F(n+1)). The theorem's hypothesis is a > b, so (1,1)
// is not in the running even though it also needs one division.
export const LAME = [
  { n: 1, a: 2, b: 1 },
  { n: 2, a: 3, b: 2 },
  { n: 3, a: 5, b: 3 },
  { n: 4, a: 8, b: 5 },
  { n: 5, a: 13, b: 8 },
  { n: 6, a: 21, b: 13 },
  { n: 7, a: 34, b: 21 },
  { n: 8, a: 55, b: 34 },
  { n: 9, a: 89, b: 55 },
];

// The claims this file REFUSES to make, because they are the pretty version and the measurement
// says otherwise. Each one is asserted in the tests as FALSE, with the counterexample written out
// by hand rather than searched for.
export const FOLKLORE = [
  {
    claim: '完美对局的手数 == 欧几里得除法次数',
    counter: { a: 7, b: 3, d: 3, cf: 2 },
    why: 'k=1 之后是 4×3，帕 = 1+2 = 3，而 7=2·3+1、3=3·1 只有两次除法。正确的是 帕 = cf + 插入数。',
  },
  {
    claim: '某个尺寸上限内最长的对局一定是相邻 Fibonacci 对',
    counter: { a: 17, b: 12, d: 6, fib: 'a<=20 内 Fibonacci 的帕只有 6 的是 (21,13)，越界' },
    why: 'a<=20 里帕的最大值是 6，取在 (17,12)、(18,13)、(19,12)；(13,8) 只有 5。插入打破了 Fibonacci 的最优性。',
  },
  {
    claim: '胜口可以用 1 < (a-kb)/b < φ 判（对所有 k 一致）',
    counter: { a: 11, b: 4, k: 2 },
    why: '(11-2·4)/4 = 0.75 落在 (1,φ) 之外，按这条说法 k=2 不是胜口；可 k=2 的后继是 (4,3)，一个必败局，所以它正是唯一胜口。'
      + 'k = q 的后继是 (b, r) 而不是 (a-kb, b)，判据要换成 b² < b·r + r²（这里 r=3：16 < 12 + 9 成立）。',
  },
];
