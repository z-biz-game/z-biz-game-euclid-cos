// The view: pixels and gestures only. It never decides legality (js/core/game.js does) and never
// classifies a position (js/core/book.js does) — the three layers stay apart so a node run can
// import the rules without a DOM.
//
// Everything drawn here is procedural: gradients, bevels, hatch, a guide line. No image, no font
// file, no audio asset.
//
// THE SIGNATURE VISUAL is the golden guide: a vertical brass line at x = phi*b. It is not
// decoration, it is the verdict drawn as a ruler — js/core/golden.js proves the mover loses
// exactly when a/b < phi, i.e. exactly when the RIGHT EDGE of the bar falls to the LEFT of that
// line. Read off the canvas, "am I winning" is "does my bar overshoot the brass line", and the
// shaded gap between the two is |a - phi*b| in the same direction as the integer margin
// a^2 - ab - b^2. The line's position uses a float because it is a RULER; the verdict never reads
// this number, and the text beside it prints the integer margin.
//
// Coordinate contract with the harness: `cutPoint(k)` and `barPoint(col)` return CLIENT
// coordinates (canvas rect included), which is exactly what CDP's `Input.dispatchMouseEvent`
// wants; `colAt(x)` is the inverse. If the two ever disagree by even the canvas offset, the browser
// suite clicks empty space and the cut is correctly refused — which is why @pointer exists.

import { cutBlocks, legalMoves, quotient } from './core/euclid.js';

const GAP = 2;             // px groove between unit squares
const PAD = 18;            // px of wrapper around the bar
const MIN_CELL = 4;
const MAX_CELL = 46;

// phi as a ratio of two Fibonacci numbers (F(31)/F(30)), accurate to ~4e-13 — far below a pixel
// at any cell size this game draws. Used ONLY for the guide line's position.
const PHI_NUM = 1346269;
const PHI_DEN = 832040;

export const PALETTE_TOKENS = {
  paper: '--c-paper',
  tray: '--c-tray',
  gold: '--c-gold',
  goldDark: '--c-gold-dark',
  brass: '--c-brass',
  ink: '--c-ink',
  win: '--c-win',
  loss: '--c-loss',
};

function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const [name, token] of Object.entries(PALETTE_TOKENS)) {
    const v = cs.getPropertyValue(token).trim();
    out[name] = v || '#888';
  }
  return out;
}

export function createView(canvas, getState, opts = {}) {
  const ctx = canvas.getContext('2d');
  const reducedMotion = opts.reducedMotion === true;
  const PAL = typeof document === 'undefined' ? {} : readTokens();
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let cell = MIN_CELL;
  let originX = PAD;
  let originY = PAD;

  // The bar is fitted with the ROOT dimensions so the scale never jumps mid-match: a cut shrinks
  // the picture inside a stable grid instead of sliding under the finger.
  function grid() {
    const st = getState();
    const [rootA, rootB] = st.root;
    const a = st.a || rootA;
    const b = st.b || rootB;
    return { a, b, rootA, rootB };
  }

  function layout() {
    const { rootA, rootB } = grid();
    const availW = cssW - PAD * 2;
    const availH = cssH - PAD * 2 - 18; // the strip under the bar carries the dimension text
    cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(Math.min(
      (availW - GAP * (rootA - 1)) / rootA,
      (availH - GAP * (rootB - 1)) / rootB,
    ))));
    const w = rootA * cell + (rootA - 1) * GAP;
    const h = rootB * cell + (rootB - 1) * GAP;
    originX = Math.round((cssW - w) / 2);
    originY = Math.round((cssH - h) / 2) - 6;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cssW = Math.max(60, Math.round(rect.width));
    cssH = Math.max(60, Math.round(rect.height));
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layout();
    draw();
  }

  // ---- geometry --------------------------------------------------------------
  // Unit square (col, row) with col along the long side.
  function unitRect(col, row) {
    return {
      x: originX + col * (cell + GAP),
      y: originY + row * (cell + GAP),
      w: cell,
      h: cell,
    };
  }

  // Client coords of the middle of the k-th b-wide block — what the harness clicks to cut k.
  function cutPoint(k) {
    const { b } = grid();
    const col = Math.max(0, Math.min(grid().a - 1, k * b - 1));
    const q = unitRect(col, Math.floor(b / 2));
    const rect = canvas.getBoundingClientRect();
    return { x: Math.round(rect.left + q.x + q.w / 2), y: Math.round(rect.top + q.y + q.h / 2) };
  }

  // Which column of the bar is under this client x? null off the bar.
  function colAt(x, y) {
    const rect = canvas.getBoundingClientRect();
    const { a, b } = grid();
    const lx = x - rect.left - originX;
    const ly = y - rect.top - originY;
    const col = Math.floor((lx + GAP) / (cell + GAP));
    const row = Math.floor((ly + GAP) / (cell + GAP));
    if (col < 0 || row < 0 || col >= a || row >= b) return null;
    return { col, row };
  }

  // The k a hover at this point means, or null when the point is not on the bar at all — hover
  // must be able to say "nothing", or moving off the bar would leave a preview burning.
  function kAt(x, y) {
    const hit = colAt(x, y);
    if (!hit) return null;
    const st = getState();
    const q = quotient(st.a, st.b);
    return Math.max(1, Math.min(q, Math.floor(hit.col / st.b) + 1));
  }

  // A DRAG off an edge sticks to the boundary instead of dropping the gesture: a silent drop looks
  // exactly like an ignored finger, which is what the @pointer suite asserts ("过拉钳制在边界").
  function clampToBar(x, y) {
    const rect = canvas.getBoundingClientRect();
    const { a, b } = grid();
    const st = getState();
    const q = quotient(st.a, st.b);
    const col = Math.max(0, Math.min(a - 1, Math.floor((x - rect.left - originX + GAP) / (cell + GAP))));
    return Math.max(1, Math.min(q, Math.floor(col / b) + 1));
  }

  // ---- painting --------------------------------------------------------------
  function roundRect(x, y, w, h, rad) {
    const k = Math.min(rad, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + k, y);
    ctx.lineTo(x + w - k, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + k);
    ctx.lineTo(x + w, y + h - k);
    ctx.quadraticCurveTo(x + w, y + h, x + w - k, y + h);
    ctx.lineTo(x + k, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - k);
    ctx.lineTo(x, y + k);
    ctx.quadraticCurveTo(x, y, x + k, y);
    ctx.closePath();
  }

  function unitSquare(col, row, tone, dim) {
    const q = unitRect(col, row);
    const g = ctx.createLinearGradient(q.x, q.y, q.x + q.w * 0.6, q.y + q.h);
    g.addColorStop(0, tone ? PAL.gold : PAL.brass);
    g.addColorStop(1, tone ? PAL.brass : PAL.goldDark);
    roundRect(q.x, q.y, q.w, q.h, Math.max(1, q.w * 0.18));
    ctx.fillStyle = g;
    ctx.fill();
    if (cell >= 9) {
      ctx.strokeStyle = 'rgba(255,240,205,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q.x + 1, q.y + q.h - 1);
      ctx.lineTo(q.x + 1, q.y + 1);
      ctx.lineTo(q.x + q.w - 1, q.y + 1);
      ctx.stroke();
    }
    if (dim) {
      ctx.fillStyle = 'rgba(10,8,6,0.42)';
      roundRect(q.x, q.y, q.w, q.h, Math.max(1, q.w * 0.18));
      ctx.fill();
    }
  }

  function hatch(col, row) {
    // The strip that is not a whole b-square: still gold, but scored so it reads as remainder.
    const q = unitRect(col, row);
    ctx.save();
    ctx.beginPath();
    ctx.rect(q.x, q.y, q.w, q.h);
    ctx.clip();
    ctx.strokeStyle = 'rgba(20,14,8,0.5)';
    ctx.lineWidth = 1;
    const step = Math.max(3, cell / 2);
    for (let i = -q.h; i < q.w; i += step) {
      ctx.beginPath();
      ctx.moveTo(q.x + i, q.y + q.h);
      ctx.lineTo(q.x + i + q.h, q.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function goldenGuide(a, b) {
    // x = phi * b in bar units, then in px. The bar's right edge is `a`; the verdict is which side
    // of this line it falls on.
    const units = (PHI_NUM * b) / PHI_DEN;
    const x = originX + units * (cell + GAP) - GAP / 2;
    const top = originY - 12;
    const h = b * (cell + GAP) - GAP + 24;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = PAL.ink;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + h);
    ctx.stroke();
    ctx.setLineDash([]);
    // the gap between the bar's edge and the line: |a - phi*b|, shaded toward the verdict colour
    const edge = originX + a * (cell + GAP) - GAP;
    if (Math.abs(edge - x) > 0.6) {
      const win = a > units;
      ctx.fillStyle = win ? PAL.win : PAL.loss;
      ctx.globalAlpha = 0.22;
      ctx.fillRect(Math.min(x, edge), top, Math.abs(edge - x), h);
      ctx.globalAlpha = 1;
      ctx.fillStyle = PAL.ink;
      ctx.font = `${Math.max(9, Math.min(13, Math.round(cell * 0.9)))}px ui-monospace, SFMono-Regular, monospace`;
      ctx.textAlign = edge > x ? 'left' : 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('φ·b', edge > x ? x + 3 : x - 3, top - 12);
    }
    ctx.restore();
    return { x, units };
  }

  function draw() {
    const st = getState();
    const { a, b, rootA, rootB } = grid();
    ctx.clearRect(0, 0, cssW, cssH);

    const rootW = rootA * cell + (rootA - 1) * GAP;
    const rootH = rootB * cell + (rootB - 1) * GAP;
    roundRect(originX - 8, originY - 8, rootW + 16, rootH + 16, 10);
    ctx.fillStyle = PAL.tray;
    ctx.fill();
    ctx.strokeStyle = 'rgba(217,164,65,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const q = quotient(st.a, st.b);
    const previewK = st.status === 'playing' && st.kPreview ? Math.max(1, Math.min(q, st.kPreview)) : 0;
    const blocks = previewK ? cutBlocks(st.a, st.b, previewK) : null;

    // the bar: b rows of a unit squares, block tones alternating so the Euclidean structure
    // (columns grouped in slices of width b) is visible without a legend
    for (let row = 0; row < b; row++) {
      for (let col = 0; col < a; col++) {
        const blockIdx = Math.floor(col / b);
        const inPreview = previewK && blockIdx < previewK;
        unitSquare(col, row, blockIdx % 2 === 0, !!inPreview);
        if (col >= q * b) hatch(col, row);
      }
    }

    // the cut preview: outline the k squares that are about to leave, and slide them off a little
    if (previewK) {
      const off = reducedMotion ? 0 : Math.min(cell * 0.35, 6);
      ctx.save();
      ctx.strokeStyle = PAL.ink;
      ctx.lineWidth = 2;
      for (const blk of blocks.blocks) {
        ctx.strokeRect(
          originX + blk.x + off,
          originY - off,
          blk.size * cell + (blk.size - 1) * GAP,
          b * (cell + GAP) - GAP,
        );
      }
      ctx.fillStyle = PAL.ink;
      ctx.font = `700 ${Math.max(11, Math.min(20, cell))}px ui-monospace, SFMono-Regular, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const labelX = originX + (previewK * b * (cell + GAP) - GAP) / 2;
      ctx.fillText(`切 ${previewK} 块 ${b}×${b}`, labelX, originY - 14);
      ctx.restore();
    }

    // the blocks the last move removed, dashed in that seat's colour: the answer to "what did the
    // opponent take" is visible without reading the text line. `last.blocks` is the cutBlocks()
    // RESULT ({ blocks, leftover, side }) — the array to walk is its `.blocks` field, and the
    // leftover is the remainder strip that is NOT part of the cut.
    if (st.history.length) {
      const last = st.history[st.history.length - 1];
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = last.seat === 'you' ? PAL.win : PAL.loss;
      for (const blk of last.blocks.blocks) {
        ctx.strokeRect(
          originX + blk.x + 1,
          originY + 1,
          blk.size * cell + (blk.size - 1) * GAP - 2,
          last.side * (cell + GAP) - GAP - 2,
        );
      }
      ctx.restore();
    }

    goldenGuide(a, b);

    // block rulers: one tick per b-wide block, because the hint and the panel speak in k
    ctx.save();
    ctx.fillStyle = 'rgba(243,231,207,0.62)';
    ctx.font = `${Math.max(9, Math.min(13, Math.round(cell * 0.9)))}px ui-monospace, SFMono-Regular, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const baseY = originY + b * (cell + GAP) - GAP + 6;
    for (let i = 0; i < q; i++) {
      const x = originX + (i * b + b / 2) * (cell + GAP);
      if (x > originX + rootW + 2) break;
      ctx.fillText(String(i + 1), x, baseY);
    }
    ctx.textAlign = 'left';
    ctx.fillText(`${a}×${b} · 可切 1–${q}`, originX - 6, baseY + 15);
    ctx.restore();
  }

  return {
    resize,
    draw,
    layout,
    cutPoint,
    colAt,
    kAt,
    clampToBar,
    unitRect,
    legalKs: () => legalMoves(getState().a, getState().b),
    metrics: () => ({ cell, originX, originY, gap: GAP, pad: PAD, dpr, cssW, cssH, a: getState().a, b: getState().b, reducedMotion }),
    goldenPx: (b) => ((PHI_NUM * b) / PHI_DEN) * (cell + GAP),
  };
}
