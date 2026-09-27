// The opening book: the serialised form of the exhaustive table, and the ONLY thing the browser
// consults while you play.
//
// Shape of the shipped payload (the BOOK export of js/data/lots.js, written by tools/bake.mjs):
//   { bound: 60, states: 1830, win: 1161, loss: 669, rows: [ "1:1:win/1/1", ... ] }
// One row per position of the grid {1 <= b <= a <= bound}, in ascending-a / ascending-b order:
//
//     <a>:<b>:<value>/<k>/<depth>
//
//   value  'win' | 'loss' — the verdict for the player to move (both routes agreed before write)
//   k      the move perfect play makes: the unique winning move, or (already lost) the one that
//          keeps the game longest. It is a MOVE, not a hint — the opponent has no search behind it.
//   depth  plies left under perfect play, i.e. "par". The readout prints it as 帕.
//
// Why a table and not a solver in the page: the grid is CLOSED under the move relation
// (js/core/euclid.js states the invariant; js/core/retro.js `table()` asserts it by refusing to
// index outside itself), so these 1830 rows answer every rectangle the screen can display and a
// lookup can never miss. A solver on the tap path would be a second, unbaked source of truth —
// two answers per question is one too many.
//
// `lookup()` THROWS on an out-of-book position instead of falling back to live search. That is a
// safety property, not laziness: a silent fallback would let a bigger board or a bad seed drift
// into an engine the bake never reconciled, and "the shipped table and the played table are the
// same object" would stop being falsifiable. If this error ever appears on screen, the bound moved
// and the book did not — re-run `node tools/bake.mjs`.

import { checkPair, pairKey, successor } from './euclid.js';
import { table } from './retro.js';

const ROW_RE = /^(\d+):(\d+):(win|loss)\/(\d+)\/(\d+)$/;

class MissError extends Error {}
export const isMissError = (e) => e instanceof MissError;

// ------------------------------------------------------------ encode
// One formatter on purpose: bake writes with it, `recomputeBook` re-encodes with it, so the
// shipped text and the live text are compared through the same function and cannot disagree
// because of formatting.
export function encodeRow(node) {
  return `${node.a}:${node.b}:${node.value}/${node.chosen}/${node.depth}`;
}

export function encodeBook(grid) {
  let bound = 0;
  for (const node of grid.values()) if (node.a > bound) bound = node.a;
  const rows = [];
  for (let a = 1; a <= bound; a++) {
    for (let b = 1; b <= a; b++) {
      const node = grid.get(pairKey(a, b));
      if (!node) throw new Error(`encodeBook: 网格缺行 ${a}:${b}`);
      rows.push(encodeRow(node));
    }
  }
  let win = 0;
  let loss = 0;
  for (const node of grid.values()) {
    if (node.value === 'win') win++;
    else loss++;
  }
  return { bound, states: rows.length, win, loss, rows };
}

// ------------------------------------------------------------ decode + audit
// Validates the TEXT, not our memory of it: declared counts, row shape, no duplicates, no missing
// cell in the triangle — and the cross-field consistency that must hold inside ANY correct book:
// a 'win' row's k is legal, the successor it hands over is a 'loss' row already in the book (or
// nothing, when the cut tiles the bar exactly), and depth is 1 + the successor's depth. A 'loss'
// row must have exactly one legal move (Theorem A), else the book would be claiming a forced line
// where the mover actually had a choice.
export function decodeBook(payload) {
  if (!payload || !Array.isArray(payload.rows)) throw new TypeError('book.rows 缺失：棋书未烘焙');
  const { bound } = payload;
  if (!Number.isInteger(bound) || bound < 1) throw new TypeError('book.bound 需要正整数');
  const triangle = (bound * (bound + 1)) / 2;
  if (payload.rows.length !== triangle) {
    throw new Error(`book: 边界 ${bound} 应有 ${triangle} 行，实际 ${payload.rows.length} 行`);
  }
  if (Number.isInteger(payload.states) && payload.states !== payload.rows.length) {
    throw new Error(`book: 声明 states=${payload.states}，实际 ${payload.rows.length} 行`);
  }
  const map = new Map();
  for (const line of payload.rows) {
    if (typeof line !== 'string') throw new Error(`book: 非字符串行 ${JSON.stringify(line)}`);
    const hit = ROW_RE.exec(line);
    if (!hit) throw new Error(`book: 无法解析的行 ${JSON.stringify(line)}`);
    const a = Number(hit[1]);
    const b = Number(hit[2]);
    if (b > a) throw new Error(`book: 行未规范化（b > a）: ${line}`);
    if (a > bound) throw new Error(`book: 行越界（bound=${bound}）: ${line}`);
    const key = pairKey(a, b);
    if (map.has(key)) throw new Error(`book: 重复的局面 ${key}（${line}）`);
    map.set(key, { key, a, b, value: hit[3], k: Number(hit[4]), depth: Number(hit[5]), raw: line });
  }
  for (let a = 1; a <= bound; a++) {
    for (let b = 1; b <= a; b++) {
      const row = map.get(pairKey(a, b));
      if (!row) throw new Error(`book: 缺行 ${a}:${b}（三角不闭合）`);
      const q = Math.floor(a / b);
      if (row.k < 1 || row.k > q) throw new Error(`book: ${row.raw} 的 k 非法（q=${q}）`);
      const next = successor(a, b, row.k);
      if (row.value === 'win') {
        if (next === null) {
          if (row.k !== q) throw new Error(`book: ${row.raw} 恰好铺满却没切到尽头（q=${q}）`);
          if (row.depth !== 1) throw new Error(`book: ${row.raw} 一步铺满却 depth!=1`);
          continue;
        }
        const child = map.get(pairKey(next[0], next[1]));
        if (child.value !== 'loss') throw new Error(`book: ${row.raw} 的胜口交给对手一个 ${child.value}`);
        if (child.depth + 1 !== row.depth) {
          throw new Error(`book: ${row.raw} 与后继 ${child.raw} 的深度差不是 1`);
        }
      } else {
        if (q !== 1) throw new Error(`book: ${row.raw} 判负却还有 ${q} 个合法口（Theorem A 被推翻）`);
        if (next === null) throw new Error(`book: ${row.raw} 铺满了还判负`);
        const child = map.get(pairKey(next[0], next[1]));
        if (child.value !== 'win') throw new Error(`book: ${row.raw} 的 forced 后继不是胜局`);
        if (child.depth + 1 !== row.depth) {
          throw new Error(`book: ${row.raw} 与后继 ${child.raw} 的深度差不是 1`);
        }
      }
    }
  }
  map.bound = bound;
  return map;
}

// ------------------------------------------------------------ the questions the game asks
export function inBook(map, a, b) {
  try {
    return map.has(pairKey(a, b));
  } catch {
    return false;
  }
}

export function lookup(map, a, b) {
  const [x, y] = checkPair(a, b);
  const key = pairKey(x, y);
  const hit = map.get(key);
  if (!hit) {
    throw new MissError(`book: 局面 ${key} 不在棋书里（边界 a<=${map.bound}），拒绝现场搜索`);
  }
  return hit;
}

export const valueOf = (map, a, b) => lookup(map, a, b).value;
export const isWin = (map, a, b) => valueOf(map, a, b) === 'win';
export const isLoss = (map, a, b) => valueOf(map, a, b) === 'loss';
export const par = (map, a, b) => lookup(map, a, b).depth;

// The move perfect play makes from here. The AI plays it when it is the mover and the hint button
// shows it when you are — both read the SAME row, which is why the opponent can be no luckier
// than the hint: there is no policy here, only the table.
export const bestK = (map, a, b) => lookup(map, a, b).k;

// ------------------------------------------------------------ the falsification hook
// window.euclid.recomputeBook(): rebuild the grid in the page with route 1, re-encode it, and
// compare against the shipped rows element by element. A non-zero mismatch count means every
// "measured" claim in the docs is stale. main.js exposes it; tools/playtest.mjs asserts 0.
export function recomputeBook(payload = null) {
  const bound = payload && Number.isInteger(payload.bound) ? payload.bound : null;
  if (bound === null) throw new TypeError('recomputeBook: 需要携带 bound 的棋书负载');
  const fresh = encodeBook(table(bound));
  const mismatches = [];
  for (let i = 0; i < Math.max(fresh.rows.length, payload.rows.length); i++) {
    if (fresh.rows[i] !== payload.rows[i]) {
      mismatches.push(`${JSON.stringify(payload.rows[i] ?? null)} != ${JSON.stringify(fresh.rows[i] ?? null)}`);
    }
  }
  return {
    bound,
    rows: fresh.rows.length,
    same: mismatches.length === 0,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 8),
  };
}
