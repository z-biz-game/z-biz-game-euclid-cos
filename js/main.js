// The shell: DOM, router, save file, and the `window.euclid` hook the browser suite drives.
// It owns no game theory. Every verdict it prints comes from js/core/book.js (a table lookup) and
// every legality answer from js/core/game.js. If a number appears here that is not in those two
// files, it was not measured.
//
// The one consequence of the maths that the shell leans on hardest: a WON game always lasts
// EXACTLY par plies. The winner's move is unique (Theorem B) and a lost position has exactly one
// legal move at all (Theorem A), so the entire line is forced — there is no "cleared in 5 but par
// is 7". The card prints both numbers and they are equal, and @play asserts it on a real click.

import { margin, pairKey, parsePairKey, quotient, ratioText, squareCount } from './core/euclid.js';
import { bookMap, campaign, dailyLot, lotById, poolStats, randomLot, tierKeys, verifyPool } from './core/library.js';
import { aiTurn, classifyNow, hintAt, playCut, playerCut, startMatch, undoRound } from './core/game.js';
import { BOOK } from './data/lots.js';
import { lookup, recomputeBook } from './core/book.js';
import { solve as solveLive, table as tableLive } from './core/retro.js';
import { isLoss as phiIsLoss, winningK as phiWinningK, depth as phiDepth, reconcile as phiReconcile } from './core/golden.js';
import { persistent, store } from './core/storage.js';
import { todayKey } from './core/rng.js';
import { createView } from './view.js';

const VERSION = 1;
const IDS = ['board', 'ks', 'hintline', 'curtain', 'stars', 'verdict', 'tally', 'again', 'next', 'crumbs',
  'readout', 'hint', 'undo', 'autowin', 'restart', 'share', 'modes', 'totals', 'proof', 'proofcount',
  'proofmore', 'wipe', 'toast'];
const el = {};
for (const id of IDS) el[id] = document.getElementById(id);

const map = bookMap();
const lots = campaign();

const game = {
  lot: null,
  match: null,
  dragging: false,
  hints: 0,
  mode: 'campaign',
  index: 1,
  settled: false,
  record: null,
};

// ------------------------------------------------------------------ routing
function routeTo(hash) {
  const h = String(hash || '').replace(/^#/, '') || '/';
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'daily') return dailyLot(todayKey());
  if (parts[0] === 'lot' && parts[1]) return lotById(parts[1]) || null;
  if (parts[0] === 'c') {
    const n = Number(parts[1]);
    const idx = !Number.isFinite(n) ? 1 : Math.max(1, Math.min(lots.length, Math.floor(n)));
    game.index = idx;
    return lots[idx - 1];
  }
  if (parts[0] === 'random') {
    const tier = tierKeys.includes(parts[1]) ? parts[1] : undefined;
    const seed = parts[2] || todayKey();
    const lot = randomLot(seed, tier);
    if (!parts[2]) location.hash = `#/random/${lot.tier}/${seed}`;
    return lot;
  }
  return null;
}

function load(hash, { push = true } = {}) {
  let lot = routeTo(hash);
  if (!lot) {
    // An unknown lot id / empty route falls back to the campaign rather than blanking the board.
    game.index = 1;
    lot = lots[0];
    if (push) location.hash = '#/c/1';
  }
  game.lot = lot;
  game.mode = lot.mode || 'campaign';
  if (game.mode === 'campaign') {
    const i = lots.findIndex((l) => l.id === lot.id);
    if (i >= 0) game.index = i + 1;
  }
  game.match = startMatch(lot);
  game.hints = 0;
  game.settled = false;
  game.record = store.record(lot.id);
  view.layout();
  render();
  return game.lot;
}

// ------------------------------------------------------------------ rendering
function setKPreview(k) {
  const st = game.match;
  if (st.status !== 'playing') return null;
  const q = quotient(st.a, st.b);
  game.match = { ...st, kPreview: Math.max(1, Math.min(q, k)) };
  return game.match.kPreview;
}

function clearKPreview() {
  game.match = { ...game.match, kPreview: null };
}

function readout() {
  const lot = game.lot;
  const st = game.match;
  const cls = classifyNow(map, st);
  const rows = [
    ['金条', `${st.a}×${st.b}（开局 ${lot.a}×${lot.b}）`],
    ['比值 a/b', `${ratioText(st.a, st.b, 5)} · φ≈1.61803`],
    ['整数判据 a²−ab−b²', `${margin(st.a, st.b)}`, cls.value === 'win' ? 'win' : 'loss'],
    ['当前判定', `${cls.verdict} · 对${cls.forSeat}（帕 ${cls.par}）`, cls.value === 'win' ? 'win' : 'loss'],
    ['可切的块数 q', `${cls.q}（k = 1…${cls.q}）`],
    ['开局证明', `${lot.winner}必胜 · 唯一胜口 k=${lot.k}`, 'win'],
    ['猜中率 1/q', `${(100 / lot.q).toFixed(lot.q === 1 ? 0 : 1)}%`],
    ['已用手数', `${st.plies}（你 ${st.youCuts} · 对手 ${st.aiCuts}）`],
    ['已切方金', `${st.squares} / ${squareCount(lot.a, lot.b)} 块`],
    ['提示', String(game.hints)],
  ];
  el.readout.innerHTML = rows.map(([k, v, c]) => `<dt>${k}</dt><dd${c ? ` class="${c}"` : ''}>${v}</dd>`).join('');
  el.proofcount.textContent = `(${lookup(map, lot.a, lot.b).depth} 手)`;
  el.proof.innerHTML = game.proofRows().map((p) => `<li>${p}</li>`).join('');
  el.proofmore.textContent = '以上每一行都是 BOOK 的查表结果，页面没有跑搜索：重烘 `node tools/bake.mjs`、复算 `npm run unit`。';
}

// The proof drawer: the forced line, built from BOOK lookups only. One row per ply, and the last
// row is the exact tiling — which is the whole certification, readable without trusting a theorem.
game.proofRows = () => {
  const lot = game.lot;
  const root = lookup(map, lot.a, lot.b);
  const rows = [
    `开局 <code>${lot.a}×${lot.b}</code>：棋书判 <b>${root.value === 'win' ? '必胜' : '必败'}</b>，帕 <b>${root.depth}</b>，胜口 <b>k=${root.k}</b>`,
    `两条独立路线各自判一次：穷举格 <code>js/core/retro.js</code> 与整数 φ 判据 <code>js/core/golden.js</code>，烘焙前逐局面比对；本页现算复核 ${game.reconcileCount} 个局面，分歧 <b>${game.reconcileBad}</b> 个`,
    `唯一胜口意味着整条线路只有一条：下面每一步都是表里的着法，最后一步正好铺满`,
  ];
  let [a, b] = [root.a, root.b];
  let ply = 0;
  while (ply < root.depth) {
    const row = lookup(map, a, b);
    const rest = a - row.k * b;
    ply++;
    if (rest === 0) {
      rows.push(`第 ${ply} 手（${ply % 2 ? '你' : '对手'}）：切 ${row.k} 块 ${b}×${b}，${a}−${row.k}·${b}=0 —— <b>铺满，先手胜</b>`);
      break;
    }
    const nx = Math.max(b, rest);
    const ny = Math.min(b, rest);
    rows.push(`第 ${ply} 手（${ply % 2 ? '你' : '对手'}）：${a}×${b} 切 ${row.k} 块 → ${nx}×${ny}（判 ${row.value === 'win' ? '必胜' : '必败'}，帕 ${row.depth}）`);
    a = nx;
    b = ny;
  }
  return rows;
};
game.reconcileCount = BOOK.states;
game.reconcileBad = 0;

function totals() {
  const t = store.totals();
  const s = poolStats();
  const streak = store.streak(todayKey());
  el.totals.textContent = `通关 ${t.cleared}/${s.lots} · 胜 ${t.wins} 负 ${t.losses} · 连续 ${streak} 天 · 棋书 ${s.states} 局面`;
}

function ksRow() {
  const st = game.match;
  const q = quotient(st.a, st.b);
  const open = st.status === 'playing';
  el.ks.hidden = !open;
  if (!open) {
    el.ks.innerHTML = '';
    return;
  }
  const best = open ? lookup(map, st.a, st.b).k : null;
  const showBest = game.hints > 0;
  const cells = [];
  for (let k = 1; k <= q; k++) {
    const pressed = st.kPreview === k;
    cells.push(`<button type="button" data-k="${k}" aria-pressed="${pressed ? 'true' : 'false'}"${showBest && k === best ? ' class="best"' : ''}>k=${k}</button>`);
  }
  el.ks.innerHTML = cells.join('');
}

function curtain() {
  const st = game.match;
  const lot = game.lot;
  if (st.status === 'playing') {
    el.curtain.hidden = true;
    return;
  }
  el.curtain.hidden = false;
  const won = st.status === 'won';
  const clean = won && game.hints === 0;
  el.stars.textContent = won ? (clean ? '★★★' : '★★☆') : '☆☆☆';
  el.verdict.textContent = won ? '你铺满了金条' : '对手铺满了金条';
  const best = game.record && game.record.best;
  el.tally.textContent = `帕 ${lot.depth} · 实走 ${st.plies} 手 · 切下 ${st.squares} 块方金${best ? ` · 纪录 ${best} 手` : ''}${won ? ' · 一帕不差' : ''}`;
  el.next.hidden = game.mode !== 'campaign' || game.index >= lots.length;
}

function render() {
  const st = game.match;
  const lot = game.lot;
  el.crumbs.innerHTML = `<b>${lot.label || `${lot.a}×${lot.b}`}</b> · ${lot.tier}` +
    (game.mode === 'campaign' ? ` · 第 ${game.index}/${lots.length} 关` : '') +
    (game.mode === 'daily' ? ` · ${lot.day}` : '');
  el.hintline.textContent = st.line;
  readout();
  ksRow();
  curtain();
  totals();
  for (const btn of el.modes.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === game.mode));
  }
  view.draw();
}

// ------------------------------------------------------------------ feedback
let toastTimer = null;
function toast(msg, bad = false) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  el.toast.classList.toggle('bad', !!bad);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2600);
}

// ------------------------------------------------------------------ the moves
function settle(result) {
  if (result.rejected) {
    game.match = result.state;
    clearKPreview();
    render();
    toast(result.rejected, true);
    return result;
  }
  game.match = result.state;
  clearKPreview();
  if (game.match.status !== 'playing' && !game.settled) {
    game.settled = true;
    const won = game.match.status === 'won';
    game.record = store.finish(game.lot.id, { won, plies: game.match.plies, hints: game.hints });
    if (game.mode === 'daily') store.markDaily(game.lot.day, game.lot.id, { won });
    if (won && game.mode === 'campaign') store.unlock(Math.min(lots.length, game.index + 1));
    game.match = { ...game.match, kPreview: null };
  }
  render();
  return result;
}

function tapK(k) {
  const st = game.match;
  if (st.status !== 'playing') {
    return settle({ state: st, rejected: '本局已结束' });
  }
  if (st.turn !== 'you') {
    return settle({ state: st, rejected: '还没轮到你' });
  }
  return settle(playerCut(map, st, k));
}

function autoWin() {
  let st = game.match;
  let guard = 0;
  while (st.status === 'playing' && guard++ < 200) {
    const k = lookup(map, st.a, st.b).k;
    const r = st.turn === 'you' ? playCut(map, st, k, 'you') : aiTurn(map, st);
    if (r.rejected) throw new Error('autoWin: ' + r.rejected);
    st = r.state;
  }
  if (st.status === 'playing') throw new Error('autoWin: 表里走不完这一局');
  game.match = st;
  if (!game.settled) {
    game.settled = true;
    const won = st.status === 'won';
    game.record = store.finish(game.lot.id, { won, plies: st.plies, hints: game.hints });
    if (game.mode === 'daily') store.markDaily(game.lot.day, game.lot.id, { won });
  }
  clearKPreview();
  render();
  return { won: st.status === 'won', plies: st.plies, par: game.lot.depth, squares: st.squares };
}

function hintOnce() {
  const st = game.match;
  const h = hintAt(map, st);
  game.hints += 1;
  store.hint(game.lot.id);
  if (h.winning) setKPreview(h.k);
  game.match = { ...game.match, line: h.line };
  render();
  toast(h.line, !h.winning);
  return h;
}

function undo() {
  const r = undoRound(game.match);
  game.match = r.state;
  game.settled = r.state.status === 'playing' ? false : game.settled;
  clearKPreview();
  render();
  if (r.rejected) toast(r.rejected, true);
  return r.state;
}

function restart() {
  game.match = startMatch(game.lot);
  game.hints = 0;
  game.settled = false;
  clearKPreview();
  render();
  return game.match;
}

function nextLot() {
  const i = Math.min(lots.length, game.index + 1);
  location.hash = `#/c/${i}`;
  return load(`#/c/${i}`);
}

// ------------------------------------------------------------------ gestures
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const view = createView(el.board, () => game.match, { reducedMotion });

function onDown(ev) {
  if (game.match.status !== 'playing') return;
  el.board.setPointerCapture && el.board.setPointerCapture(ev.pointerId);
  game.dragging = true;
  setKPreview(view.clampToBar(ev.clientX, ev.clientY));
  render();
}

function onMove(ev) {
  if (game.match.status !== 'playing') return;
  const before = game.match.kPreview;
  if (!game.dragging) {
    // hover feedback: the same preview the drag shows, without claiming a gesture
    if (setKPreview(view.kAt(ev.clientX, ev.clientY)) === null) return;
  } else {
    setKPreview(view.clampToBar(ev.clientX, ev.clientY));
  }
  if (game.match.kPreview !== before) render();
}

function onUp(ev) {
  if (!game.dragging) return;
  game.dragging = false;
  const k = view.clampToBar(ev.clientX, ev.clientY);
  tapK(k);
}

function onCancel() {
  game.dragging = false;
  clearKPreview();
  render();
}

el.board.addEventListener('pointerdown', onDown);
el.board.addEventListener('pointermove', onMove);
el.board.addEventListener('pointerup', onUp);
el.board.addEventListener('pointercancel', onCancel);
el.board.addEventListener('pointerleave', () => {
  if (game.dragging) return;
  clearKPreview();
  render();
});
el.ks.addEventListener('click', (ev) => {
  const k = ev.target && ev.target.dataset ? Number(ev.target.dataset.k) : NaN;
  if (Number.isInteger(k)) tapK(k);
});
el.hint.addEventListener('click', hintOnce);
el.undo.addEventListener('click', undo);
el.autowin.addEventListener('click', () => {
  const r = autoWin();
  toast(`照表收局：${r.won ? '胜' : '负'}，${r.plies} 手 / 帕 ${r.par}`);
});
el.restart.addEventListener('click', restart);
el.again.addEventListener('click', restart);
el.next.addEventListener('click', nextLot);
el.share.addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${location.hash.replace(/^#/, '')}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制：' + url);
  } catch {
    toast('复制失败，链接在地址栏：' + url, true);
  }
});
el.modes.addEventListener('click', (ev) => {
  const mode = ev.target && ev.target.dataset ? ev.target.dataset.mode : null;
  if (mode === 'campaign') location.hash = `#/c/${game.index || 1}`;
  else if (mode === 'daily') location.hash = '#/daily';
  else if (mode === 'random') location.hash = `#/random/${game.lot ? game.lot.tier : tierKeys[0]}/${todayKey()}`;
});

let wipeArmed = false;
el.wipe.addEventListener('click', () => {
  if (!wipeArmed) {
    wipeArmed = true;
    el.wipe.textContent = '再点一次确认清空';
    toast('再点一次就清空这台设备上的存档', true);
    setTimeout(() => {
      wipeArmed = false;
      el.wipe.textContent = '清空存档';
    }, 4000);
    return;
  }
  wipeArmed = false;
  el.wipe.textContent = '清空存档';
  store.reset();
  game.record = null;
  render();
  toast('存档已清空');
});

window.addEventListener('keydown', (ev) => {
  if (game.match.status !== 'playing') return;
  const q = quotient(game.match.a, game.match.b);
  if (ev.key >= '1' && ev.key <= '9') {
    const k = Number(ev.key);
    if (k <= q) {
      setKPreview(k);
      render();
      tapK(k);
      ev.preventDefault();
    }
  } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    const cur = game.match.kPreview || 1;
    setKPreview(cur + (ev.key === 'ArrowRight' ? 1 : -1));
    render();
    ev.preventDefault();
  } else if (ev.key === 'Enter' && game.match.kPreview) {
    tapK(game.match.kPreview);
    ev.preventDefault();
  }
});

window.addEventListener('hashchange', () => load(location.hash, { push: false }));
window.addEventListener('resize', () => {
  view.resize();
  render();
});

// ------------------------------------------------------------------ boot
// Seed campaign lot 1 BEFORE the first render so the shell always has a match to draw, then route
// to the real hash, then size the canvas (a canvas with no size has no pixels to assert on).
game.lot = lots[0];
game.match = startMatch(lots[0]);
const startHash = location.hash || '#/c/1';
if (!location.hash) location.hash = startHash;
load(startHash);
view.resize();
render();

// A page-level tripwire: if the two routes ever disagree inside the browser, the shell says so on
// the proof drawer instead of quietly printing one of them. Cheap (1830 lookups), and it runs once
// at boot, not per tap.
try {
  const rec = phiReconcile(BOOK.bound);
  let bad = 0;
  const grid = tableLive(BOOK.bound);
  for (const node of grid.values()) {
    if (node.value !== (phiIsLoss(node.a, node.b) ? 'loss' : 'win')) bad++;
  }
  game.reconcileCount = rec.positions;
  game.reconcileBad = rec.problems.length + bad;
  if (game.reconcileBad) toast(`两条路线分歧 ${game.reconcileBad} 处，别信这页`, true);
  readout();
} catch (err) {
  game.reconcileBad = -1;
  toast('复核失败：' + err.message, true);
}

// ------------------------------------------------------------------ the harness hook
const api = {
  version: VERSION,
  mode: () => game.mode,
  tiers: tierKeys,
  pool: poolStats(),
  book: { bound: BOOK.bound, states: BOOK.states, win: BOOK.win, loss: BOOK.loss },
  view,
  store,
  lots,
  get state() {
    const st = game.match;
    const lot = game.lot;
    // The bar never shrinks below 1 x b (an exact cut leaves a,b as they were and marks the win),
    // so the table can always classify the terminal picture too — that is what the card prints.
    const cls = classifyNow(map, st);
    return {
      id: lot.id,
      sourceId: lot.sourceId || lot.id,
      mode: game.mode,
      index: game.index,
      tier: lot.tier,
      label: lot.label,
      day: lot.day || null,
      a: st.a,
      b: st.b,
      root: st.root,
      key: pairKey(st.a, st.b),
      plies: st.plies,
      youCuts: st.youCuts,
      aiCuts: st.aiCuts,
      squares: st.squares,
      turn: st.turn,
      status: st.status,
      winner: st.winner,
      line: st.line,
      kPreview: st.kPreview || null,
      hints: game.hints,
      persist: persistent(),
      verdict: cls ? cls.verdict : null,
      value: cls ? cls.value : null,
      par: cls ? cls.par : null,
      q: cls ? cls.q : null,
      bookK: cls ? cls.k : null,
      margin: cls ? margin(st.a, st.b) : null,
      ratio: cls ? ratioText(st.a, st.b, 5) : null,
      lotK: lot.k,
      lotQ: lot.q,
      lotDepth: lot.depth,
      lotChance: lot.chance,
      best: game.record && game.record.best ? game.record.best : null,
      history: st.history.map((h) => ({ seat: h.seat, k: h.k, side: h.side, exact: h.exact })),
    };
  },
  lot: () => game.lot,
  legal: () => (game.match.status === 'playing' ? Array.from({ length: quotient(game.match.a, game.match.b) }, (_, i) => i + 1) : []),
  load,
  restart,
  undo,
  tap: (k) => {
    const r = tapK(k);
    return { rejected: r.rejected || null, line: game.match.line };
  },
  hover: (k) => setKPreview(k),
  hintMove: () => hintAt(map, game.match),
  hintOnce,
  autoWin,
  next: nextLot,
  classify: (key) => {
    const [a, b] = parsePairKey(key);
    const row = lookup(map, a, b);
    return { key: row.key, value: row.value, k: row.k, depth: row.depth, q: quotient(a, b), margin: margin(a, b) };
  },
  // route 1, live, for cross-checking the baked table from the page (never on the tap path)
  solve: (key) => {
    const [a, b] = parsePairKey(key);
    const node = solveLive(a, b);
    return { key: node.key, value: node.value, k: node.kStar, depth: node.depth, winning: node.winning, legal: node.legal };
  },
  phi: (key) => {
    const [a, b] = parsePairKey(key);
    return { value: phiIsLoss(a, b) ? 'loss' : 'win', k: phiWinningK(a, b), depth: phiDepth(a, b), margin: margin(a, b) };
  },
  golden: () => phiReconcile(BOOK.bound),
  recomputeBook: () => recomputeBook(BOOK),
  verifyShipped: () => verifyPool(),
};
window.euclid = api;
console.log(`[log] euclid v${VERSION} ready · book ${BOOK.states} 局面 · lots ${lots.length} · 分歧 ${game.reconcileBad}`);

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}
