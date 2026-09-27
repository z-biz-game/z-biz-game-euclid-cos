// The match. A pure state machine over rectangles: it knows the rules, whose turn it is, and when
// somebody tiles the bar. It does NOT draw anything (that is js/view.js) and it does not SEARCH:
// every answer the opponent gives comes from the book passed in as `map` (js/core/book.js), which
// is the whole claim of this repo — the opponent is a baked table, not a searcher.
//
// Terminal convention, stated once here because the win/loss claims depend on it:
//   a move k with a - k*b = 0 tiles the bar EXACTLY, and the mover wins on the spot. There is no
//   "opponent has no move" state: with a >= b >= 1 the quotient is always >= 1, so a position with
//   no legal cut never appears on the board. Reaching a multiple of b is therefore not "the other
//   side cannot move", it is "this side finished the tiling" — and js/core/retro.js classifies
//   successors with exactly this convention, so a mismatch here would flip every verdict in the
//   repo. test/game.test.mjs walks the shipped lots to the end against the printed 帕.
//
// The player always sits 先手 and every shipped lot is a win for the mover, so "won" means "found
// THE winning cut — there is exactly one, Theorem B — and never erred again". A loss is always the
// player's own fault, never the table's, and the readout says which cut lost it.

import { area, checkPair, cutBlocks, moveReason, quotient, successor } from './euclid.js';
import { bestK, lookup, par } from './book.js';

export const SEATS = { you: '你', ai: '对手' };

// A lot carries { id, tier, a, b, k, depth }. The match starts with the long side horizontal.
export function startMatch(lot) {
  const [x, y] = checkPair(lot.a, lot.b);
  return {
    lotId: lot.id,
    tier: lot.tier,
    root: [x, y],
    a: x,
    b: y,
    turn: 'you',
    plies: 0,
    youCuts: 0,
    aiCuts: 0,
    squares: 0,
    history: [],
    line: `金条 ${x}×${y}，你先切。长边可切 1–${quotient(x, y)} 块 ${y}×${y}。`,
    status: 'playing', // playing | won | lost
    winner: null,
    snapshots: [],
  };
}

function snapshot(st) {
  return {
    a: st.a, b: st.b, turn: st.turn, plies: st.plies,
    youCuts: st.youCuts, aiCuts: st.aiCuts, squares: st.squares,
    status: st.status, winner: st.winner,
  };
}

// Did the bar have to be turned a quarter circle to keep speaking of "the long side"? Only when
// the remainder is NARROWER than the square that was being cut: 12×5 with k=1 leaves 7×5 (long side
// still the horizontal one — no turn), with k=2 leaves 2×5, which normalises to 5×2 and is the same
// bar stood up on its end. The view always draws side `a` horizontally, so this is what the line
// text and history.rotated have to agree with.
const hasTurned = (b, next) => next[0] === b && next[1] !== b;

// How many unit squares a cut removes from the CURRENT bar — the view shades exactly this.
export function cutFootprint(st, k) {
  return area(st.a, st.b) - (st.a - k * st.b) * st.b;
}

// The book's verdict for the position the seat-to-move is in, phrased for that seat.
export function classifyNow(map, st) {
  const row = lookup(map, st.a, st.b);
  return {
    key: row.key,
    value: row.value,
    forSeat: SEATS[st.turn],
    verdict: row.value === 'win' ? '必胜' : '必败',
    winner: row.value === 'win' ? SEATS[st.turn] : SEATS[st.turn === 'you' ? 'ai' : 'you'],
    par: row.depth,
    k: row.k,
    q: quotient(st.a, st.b),
  };
}

// Every refusal says why: the shell prints `line`, and a silent no-op on screen is
// indistinguishable from a dropped click. The reason text comes from moveReason(), which is the
// single implementation of "illegal is never swallowed" (js/core/euclid.js).
function speak(state, line) {
  return { ...state, line };
}

function finish(st, winnerSeat, line) {
  return {
    state: {
      ...st,
      status: winnerSeat === 'you' ? 'won' : 'lost',
      winner: winnerSeat,
      line,
    },
    rejected: null,
  };
}

// Apply one cut by a seat. Returns { state, rejected }.
export function playCut(map, state, k, seat) {
  if (state.status !== 'playing') {
    return { state: speak(state, '本局已经结束，先重开再切'), rejected: '本局已结束' };
  }
  const who = seat || state.turn;
  if (who !== state.turn) {
    return {
      state: speak(state, `还没轮到${SEATS[who]}：现在是${SEATS[state.turn]}的口`),
      rejected: `还没轮到${SEATS[who]}`,
    };
  }
  const reason = moveReason(state.a, state.b, k);
  if (reason) return { state: speak(state, '不能这样切：' + reason), rejected: reason };

  const prev = snapshot(state);
  const next = successor(state.a, state.b, k);
  const blocks = cutBlocks(state.a, state.b, k);
  const st = {
    ...state,
    plies: state.plies + 1,
    youCuts: state.youCuts + (who === 'you' ? 1 : 0),
    aiCuts: state.aiCuts + (who === 'ai' ? 1 : 0),
    squares: state.squares + k,
    snapshots: state.snapshots.concat([prev]),
    history: state.history.concat([{
      seat: who, k, from: [state.a, state.b], side: state.b,
      blocks, rotated: next !== null && hasTurned(state.b, next), exact: next === null,
    }]),
  };
  if (next === null) {
    // The bar is fully consumed; a and b stay as they were so the view can still draw the tiling
    // (history's last entry has the q blocks that cover it exactly).
    return finish(
      st,
      who,
      `${SEATS[who]}切下第 ${k} 块 ${state.b}×${state.b}，金条铺满 —— ${SEATS[who]}胜`,
    );
  }
  st.a = next[0];
  st.b = next[1];
  st.turn = who === 'you' ? 'ai' : 'you';
  const turn = hasTurned(state.b, next) ? '，长条转了 90°' : '';
  st.line = `${SEATS[who]}切 ${k} 块 ${state.b}×${state.b}，剩 ${st.a}×${st.b}${turn}`;
  return { state: st, rejected: null };
}

// The opponent's turn, entirely from the book: one map lookup plus one legality re-check inside
// playCut. No search, ever — and no policy either: `bestK` is the unique winning cut when there is
// one, and the longest-resistance cut when the opponent is already lost (same row, same table).
export function aiTurn(map, state) {
  if (state.status !== 'playing' || state.turn !== 'ai') return { state, rejected: '不该对手走' };
  const k = bestK(map, state.a, state.b);
  return playCut(map, state, k, 'ai');
}

// The player's cut followed by the opponent's answer, as one gesture for the shell.
export function playerCut(map, state, k) {
  const first = playCut(map, state, k, 'you');
  if (first.rejected || first.state.status !== 'playing') return first;
  return aiTurn(map, first.state);
}

// The hint: the table's own cut for the position the player is in. When the position is already a
// loss the honest answer is that there is no winning cut — the hint says so, and says what par is,
// instead of inventing a plausible-looking k.
export function hintAt(map, state) {
  const row = lookup(map, state.a, state.b);
  const q = quotient(state.a, state.b);
  if (row.value !== 'win') {
    return {
      winning: false, k: null, q, par: row.depth,
      line: `已经必败：帕 ${row.depth}，${q} 个合法 k 里没有胜口 —— 切 ${row.k} 块只是拖延`,
    };
  }
  return {
    winning: true, k: row.k, q, par: row.depth,
    line: `唯一胜口：切 ${row.k} 块 ${state.b}×${state.b}（可选 1–${q}，猜中概率 1/${q}）`,
  };
}

// Step back to before the player's most recent cut — one full round (your cut and the answer it
// drew). `snapshots` holds one entry per ply, recording the state BEFORE it, so the last entry
// with turn 'you' is exactly "before your last cut". Pure: returns a new state.
export function undoRound(state) {
  const snaps = state.snapshots;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].turn !== 'you') continue;
    const t = snaps[i];
    return {
      state: {
        ...state,
        a: t.a,
        b: t.b,
        turn: 'you',
        plies: t.plies,
        youCuts: t.youCuts,
        aiCuts: t.aiCuts,
        squares: t.squares,
        snapshots: snaps.slice(0, i),
        history: state.history.slice(0, i),
        status: 'playing',
        winner: null,
        line: `退回你第 ${t.youCuts + 1} 切之前：金条 ${t.a}×${t.b}`,
      },
      rejected: null,
    };
  }
  return { state, rejected: '没有可撤销的着法' };
}

// Both seats play the table from wherever we are, to the end. Used by the shell's 自动收局 button
// and by the browser suite, so "the table beats the table" is something the page proves at runtime
// rather than something a README asserts. Throws if a book lookup or a legality re-check fails —
// a loop that does not terminate is a model bug, not a game outcome.
export function playToTable(map, state, limit = 200) {
  let st = state;
  const line = [];
  let guard = 0;
  while (st.status === 'playing' && guard++ < limit) {
    const k = bestK(map, st.a, st.b);
    const r = st.turn === 'you' ? playCut(map, st, k, 'you') : aiTurn(map, st);
    if (r.rejected) throw new Error('playToTable: ' + r.rejected);
    line.push({ seat: st.turn, k, to: [r.state.a, r.state.b] });
    st = r.state;
  }
  if (st.status === 'playing') throw new Error(`playToTable: ${limit} 手内没有终局，模型有环`);
  return { state: st, line, plies: st.plies };
}

// Replay a shipped lot with the table on both seats. For a winning lot this MUST end with the
// player having tiled the bar, in exactly `lot.depth` plies — that equality is the certification
// the browser suite and test/game.test.mjs both check, and it is what makes 帕 a measured number
// rather than a decoration.
export function perfectLine(map, lot) {
  const start = startMatch(lot);
  const r = playToTable(map, start);
  return {
    lotId: lot.id,
    winner: r.state.winner,
    plies: r.plies,
    par: par(map, lot.a, lot.b),
    squares: r.state.squares,
    line: r.line,
  };
}
