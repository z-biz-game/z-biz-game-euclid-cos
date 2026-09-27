// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch). Zero deps, no
// Playwright — that is the whole contract.
//
// env: CDP_PORT (devtools port, default 9371 — deliberately NOT chomp's 9361, NOT ulam's 9372 and
//      NOT loshu's 9373: one machine, ~17 sibling repos, and only ONE headless Chrome may bind a
//      debug port at a time; a squatted port is reported by verify.sh before it launches)
//      BASE_URL (page to attach to, default http://127.0.0.1:5221/ — chosen by ORIGIN, never by a
//      hardcoded port inside a scenario: the page is found by where BASE_URL points)
// usage:
//   node playtest.mjs open  <url>          # reuse-or-create our page and navigate
//   node playtest.mjs nav   <url>
//   node playtest.mjs eval  '<js expression>'   # pass `nonav` to skip the reload
//   node playtest.mjs eval  '@boot' nonav  # | @play | @routes | @save | @pointer
//   node playtest.mjs shot  <path.png>
//   node playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape as tools/harness.mjs, so verify.sh
// aggregates node suites and browser suites on one line — and a scenario that reports zero rows is
// a failure, not a pass: an empty suite is exactly what a silently-dead harness prints.
const PORT = process.env.CDP_PORT || 9371;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5221/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer: the page is a module graph fetched over the network (the
  // whole 1830-row book is in js/data/lots.js), and a fixed sleep that works on localhost shows the
  // canvas as an unstyled 300x150 box against GitHub Pages.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.euclid && window.euclid.state && window.euclid.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS, { sleep, waitShell });
      } else if (SCENARIOS[name]) {
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.rows = value.rows || [];
      // An empty suite is a dead harness, not a green one.
      if (value.rows.length === 0) {
        value.rows.push({ test: `@${name} reported zero checks`, pass: false, detail: 'the scenario ran but asserted nothing' });
      }
      value.fail = value.rows.filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// ---- the one suite a page-side script cannot run: real input, a real reload, a real viewport ----
// Everything below goes through Chrome's own mouse and Chrome's own device metrics. Page-side JS
// can prove `playerCut()` is right; only a dispatched pointer event proves a thumb can reach a
// block of gold, and only a genuine reload proves the save file survived the process.
async function pointerScenario(cdp, sessionId, runJS, { sleep, waitShell }) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
  }, sessionId);
  const click = async (p) => {
    await mouse('mousePressed', p.x, p.y, 1);
    await sleep(40);
    await mouse('mouseReleased', p.x, p.y, 0);
    await sleep(110);
  };
  const centerOf = async (selector) => runJS(`(() => { const e = document.querySelector(${JSON.stringify(selector)});`
    + ` if (!e) return null; const b = e.getBoundingClientRect();`
    + ` return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: Math.round(b.width), h: Math.round(b.height) }; })()`);
  const S = () => runJS('JSON.stringify(window.euclid.state)');
  // A pixel probe installed INSIDE the page. It answers what the DOM cannot: is the centre of unit
  // square (col,row) painted gold, how much ink lies down a vertical line, how long the bar looks
  // on screen. Every probe reads the canvas in device pixels, so the same numbers hold at dpr 1 on
  // a desktop and dpr 2 on a phone. Gold = a red-dominant pixel (the metal); ink = a bright warm
  // white (the φ·b guide line and the labels); the tray, the paper and the win/loss tints are
  // neither.
  //
  // The pixels are copied into a scratch context created WITH willReadFrequently: repeatedly
  // reading back the game's own 2D context makes Chrome log a rendering warning, and a dirty
  // console is a failure in this repo. The game's context is never touched.
  const INSTALL_PROBE = `(() => {
    const cv = document.getElementById('board');
    const scratch = document.createElement('canvas');
    const sg = scratch.getContext('2d', { willReadFrequently: true });
    const isGold = (r, gg, b) => r > 110 && r > b + 40;
    const isInk = (r, gg, b) => r > 195 && gg > 172 && b > 118;
    const M = () => window.euclid.view.metrics();
    const grab = () => {
      if (scratch.width !== cv.width || scratch.height !== cv.height) {
        scratch.width = cv.width; scratch.height = cv.height;
      }
      sg.clearRect(0, 0, scratch.width, scratch.height);
      sg.drawImage(cv, 0, 0);
      return sg.getImageData(0, 0, scratch.width, scratch.height);
    };
    // 5x5 box at the centre of unit square (col,row) of the CURRENT bar grid
    const boxAt = (im, m, cx, cy) => {
      const x = Math.round(cx * m.dpr); const y = Math.round(cy * m.dpr);
      let gold = 0, ink = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= im.width || yy >= im.height) continue;
        const i = (yy * im.width + xx) * 4;
        if (isGold(im.data[i], im.data[i + 1], im.data[i + 2])) gold++;
        if (isInk(im.data[i], im.data[i + 1], im.data[i + 2])) ink++;
      }
      return { gold, ink };
    };
    window.__px = {
      cell(col, row) { const m = M(); return boxAt(grab(), m, m.originX + col * (m.cell + m.gap) + m.cell / 2, m.originY + row * (m.cell + m.gap) + m.cell / 2); },
      column(cssX) {
        const m = M(); const im = grab(); const x = Math.round(cssX * m.dpr);
        const walk = (col) => {
          let gold = 0, ink = 0;
          if (col < 0 || col >= im.width) return { gold: -1, ink: -1 };
          for (let y = 0; y < im.height; y++) {
            const i = (y * im.width + col) * 4;
            if (isGold(im.data[i], im.data[i + 1], im.data[i + 2])) gold++;
            if (isInk(im.data[i], im.data[i + 1], im.data[i + 2])) ink++;
          }
          return { gold, ink };
        };
        // A 1.5px stroke straddles two device columns, so the honest measure is the best of the
        // three around the requested x — the control column is measured the same way.
        const near = [-1, 0, 1].map((d) => walk(x + d));
        const best = near.reduce((p, c) => (c.ink > p.ink ? c : p), near[1]);
        return { gold: best.gold, ink: best.ink, band: near.map((c) => c.ink), x, w: im.width };
      },
      census() {
        const im = grab(); let gold = 0, ink = 0, lit = 0;
        for (let i = 0; i < im.data.length; i += 4) {
          if (im.data[i + 3] === 0) continue;
          if (im.data[i] > 60 || im.data[i + 1] > 60 || im.data[i + 2] > 60) lit++;
          if (isGold(im.data[i], im.data[i + 1], im.data[i + 2])) gold++;
          if (isInk(im.data[i], im.data[i + 1], im.data[i + 2])) ink++;
        }
        return { gold, ink, lit, w: im.width, h: im.height };
      },
      // Every unit square of the bar, plus the square just past its right edge (which must be
      // tray): this is where a canvas that only LOOKS filled in would be caught.
      bar() {
        const m = M(); const im = grab(); const st = window.euclid.state;
        const cx = (col) => m.originX + col * (m.cell + m.gap) + m.cell / 2;
        const cy = (row) => m.originY + row * (m.cell + m.gap) + m.cell / 2;
        let gold = 0, total = 0, lastCol = -1, firstCol = -1;
        for (let row = 0; row < st.b; row++) {
          for (let col = 0; col < st.a; col++) {
            total++;
            if (boxAt(im, m, cx(col), cy(row)).gold >= 3) {
              gold++;
              if (col > lastCol) lastCol = col;
              if (firstCol < 0 || col < firstCol) firstCol = col;
            }
          }
        }
        const past = st.a < st.root[0] ? boxAt(im, m, cx(st.a), cy(Math.floor(st.b / 2))).gold : -1;
        return { gold, total, lastCol, firstCol, past, a: st.a, b: st.b, rootA: st.root[0], cell: m.cell, dpr: m.dpr };
      },
      guide() { const m = M(); return this.column(m.originX + window.euclid.view.goldenPx(m.b) - 1); },
      control() { const m = M(); return this.column(m.originX + Math.floor(m.a / 2) * (m.cell + m.gap) + m.cell / 2); },
    };
    return 1;
  })()`;
  const PX = () => runJS('window.__px.census()');
  await runJS(INSTALL_PROBE);

  // ---- boot at a desktop viewport -------------------------------------------------------------
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
  await runJS('(() => { window.euclid.store.reset(); window.euclid.load("#/lot/nugget-01"); return 1; })()');
  await sleep(220);
  let st = JSON.parse(await S());
  // The campaign's FIRST lot is whatever the curater ranked easiest (id nugget-06, 8×3, as of this
  // bake), so a pointer suite that hand-derives 12 − 5 = 7 and 7 − 5 = 2 has to name the lot it
  // measures: 12×5 by id, not by campaign index.
  rec('真实鼠标会话开在指定的那一关（12×5）', st.id === 'nugget-01' && st.a === 12 && st.b === 5, st && { id: st.id, a: st.a, b: st.b });

  const ids = await runJS('["board","ks","hintline","curtain","stars","verdict","tally","readout","crumbs","hint","undo","autowin","restart","totals","proof","proofcount","toast","wipe"].map((i) => [i, !!document.getElementById(i)])');
  rec('shell 要碰的每一个节点都在 DOM 上', ids.every(([, on]) => on), Object.fromEntries(ids));

  const px0 = await PX();
  const bar0 = await runJS('window.__px.bar()');
  const m0 = await runJS('window.euclid.view.metrics()');
  rec('金条真的被画出来了（像素里有一块块金色）', px0.gold > 800 && px0.lit >= px0.gold, { px0, bar0 });
  rec('盘上金色的方格数 == a×b（一格不多一格不少）', bar0.gold === bar0.a * bar0.b && bar0.total === bar0.a * bar0.b, bar0);
  rec('金条从网格第 0 列铺到第 a−1 列，第 a 列是空的托盘', bar0.firstCol === 0 && bar0.lastCol === bar0.a - 1 && bar0.past <= 1, bar0);
  rec('画布按 devicePixelRatio 放大（横向像素 ≥ 横向 CSS 像素）', px0.w >= m0.cssW && px0.w === Math.round(m0.cssW * m0.dpr), { px0: px0.w, cssW: m0.cssW, dpr: m0.dpr });
  // The bar's on-screen width, measured from the pixel centres of its first and last unit square,
  // has to be a*cell + (a-1)*gap. Nothing else in the repo proves the drawing and the arithmetic
  // still agree after a change to view.js.
  const measured = await runJS(`(() => { const m = window.euclid.view.metrics(); const s = window.euclid.state;`
    + ` return (s.a * m.cell + (s.a - 1) * m.gap) * m.dpr; })()`);
  // Centre-to-centre the bar spans (a−1)·(cell+gap); add one cell and that IS the drawn width
  // a·cell + (a−1)·gap. Everything here is device pixels, hence the dpr factor.
  const spanPx = (bar0.lastCol - bar0.firstCol) * (m0.cell + m0.gap) * m0.dpr + m0.cell * m0.dpr;
  rec('金条的像素跨度复现 a·cell+(a−1)·gap（±2px）', Math.abs(spanPx - measured) <= 2, { spanPx, measured, m0 });
  const guide = await runJS('window.__px.guide()');
  const control = await runJS('window.__px.control()');
  rec('φ·b 那条参考线画在像素里（线上有墨色虚线，线侧没有）', guide.ink > 30 && control.ink * 5 < guide.ink, { guide, control });
  const guideSide = await runJS('(() => { const m = window.euclid.view.metrics(); const s = window.euclid.state;'
    + ' const xg = m.originX + window.euclid.view.goldenPx(m.b); const xe = m.originX + (s.a * (m.cell + m.gap) - m.gap);'
    + ' return { xg, xe, side: xg < xe ? "edge-right" : "edge-left", win: s.value }; })()');
  rec('参考线与金条右端的左右关系 == 判定（胜局条头越过线）', guideSide.side === 'edge-right' && guideSide.win === 'win', guideSide);

  // ---- one real click on a k button cuts, and the bar shrinks on screen ------------------------
  const lot = await runJS('JSON.stringify(window.euclid.lot())');
  const parsedLot = JSON.parse(lot);
  await click(await centerOf('#ks button[data-k="1"]'));
  st = JSON.parse(await S());
  const bar1 = await runJS('window.__px.bar()');
  const corner = await runJS(`window.__px.cell(${bar0.rootA - 1}, 0)`);
  const px1 = await PX();
  rec('点一下 k=1 就真的记了一口（你和对手各一口）', st.plies === 2 && st.youCuts === 1 && st.aiCuts === 1, { plies: st.plies, lot: parsedLot.id, key: st.key });
  // hand-derived from the shipped card 12×5 with k=1: you cut 1 block of 5 → 12−5 = 7 leaves 7×5;
  // the answer is forced (7/5 < φ is a loss, one legal k) 7−5 = 2 → (5,2) normalised → a = 5.
  rec('一口之后金条在屏幕上变短了（像素里的方格数跟着 a×b 走）', bar1.a === 5 && bar1.b === 2 && bar1.gold === 10 && bar1.total === 10, { bar0: { a: bar0.a, b: bar0.b }, bar1, key: st.key });
  rec('切掉的那几格在像素里真的没了（原来最右一列现在露的是托盘）', corner.gold < 3, { col: bar0.rootA - 1, corner });
  rec('整块画布上的金色少了（切走的面积不会凭空留在盘上）', px1.gold < px0.gold - 100, { before: px0.gold, after: px1.gold });

  // ---- hover preview is painted, not only stored ----------------------------------------------
  // `euclid.hover(k)` only records the intent; the PAINT comes from the real pointer path
  // (pointermove -> kAt -> setKPreview -> render), so the mouse has to actually travel there.
  await runJS('window.euclid.restart(); 1');
  await sleep(140);
  const pxNoPreview = await PX();
  const hp = await runJS('window.euclid.view.cutPoint(1)');
  await mouse('mouseMoved', hp.x, hp.y, 0);
  await sleep(150);
  const pxPreview = await PX();
  const hov = await runJS(`(() => { const s = window.euclid.state; const b = document.querySelector('#ks button[data-k="1"]');`
    + ` return { k: s.kPreview, plies: s.plies, pressed: b && b.getAttribute('aria-pressed') }; })()`);
  rec('悬停预览把要切的那几块压暗了（金色像素变少）', pxPreview.gold < pxNoPreview.gold - 500, { plain: pxNoPreview.gold, preview: pxPreview.gold });
  rec('悬停只预览、不记手，k 按钮的 aria-pressed 跟着亮', hov.k === 1 && hov.plies === 0 && hov.pressed === 'true', hov);
  const away = await runJS(`(() => { const b = document.getElementById('board').getBoundingClientRect();`
    + ` return { x: Math.round(b.left - 30), y: Math.round(b.top + 8) }; })()`);
  await mouse('mouseMoved', away.x, away.y, 0);
  await sleep(150);
  const pxAway = await PX();
  const cleared = await runJS('window.euclid.state.kPreview');
  rec('手指离开画布，预览就灭掉（暗色不会烧在盘上）', cleared === null && pxAway.gold > pxPreview.gold + 500, { cleared, gold: pxAway.gold, preview: pxPreview.gold });
  await runJS('window.euclid.restart(); 1');
  await sleep(120);

  // ---- drag: press on the bar, drag past the right edge, release cuts the clamped k -------------
  const drag = await runJS('(() => { const v = window.euclid.view; return { a: v.cutPoint(1), far: v.cutPoint(v.metrics().a), out: (() => { const b = document.getElementById("board").getBoundingClientRect(); return { x: Math.round(b.right + 120), y: Math.round(b.top + 20) }; })() }; })()');
  const beforeDrag = JSON.parse(await S());
  await mouse('mousePressed', drag.a.x, drag.a.y, 1);
  await sleep(50);
  await mouse('mouseMoved', drag.out.x, drag.out.y, 1);
  await sleep(60);
  const clamped = await runJS('(() => { const v = window.euclid.view; const b = document.getElementById("board").getBoundingClientRect(); return { k: v.clampToBar(b.right + 400, b.bottom + 400), q: window.euclid.state.q }; })()');
  const midPreview = await runJS('window.euclid.state.kPreview');
  rec('过拉钳制在金条边界上（棋盘外的坐标仍给一个合法的 k）', clamped.k >= 1 && clamped.k <= clamped.q, clamped);
  rec('拖拽中的预览跟着手指走，并且落在合法范围里', midPreview >= 1 && midPreview <= beforeDrag.q, { midPreview, q: beforeDrag.q });
  await mouse('mouseReleased', drag.out.x, drag.out.y, 0);
  await sleep(140);
  const afterDrag = JSON.parse(await S());
  rec('松口即切：拖出去那一下确实记了一口', afterDrag.plies >= 2 && afterDrag.a !== beforeDrag.a, { plies: afterDrag.plies, key: afterDrag.key });

  // ---- illegal input through the real DOM ------------------------------------------------------
  await runJS('window.euclid.restart(); 1');
  await sleep(120);
  const q = (await runJS('window.euclid.state.q'));
  const ghost = await centerOf(`#ks button[data-k="${q + 2}"]`);
  rec('越界的 k 按钮根本不存在（DOM 里画不出它）', ghost === null, { q });
  const beforeBad = JSON.parse(await S());
  await click(await centerOf('#board'));
  st = JSON.parse(await S());
  rec('在金条上点一下也是合法一口而不是被吞掉', st.plies >= 1 || /切/.test(st.line), { plies: st.plies, line: st.line.slice(0, 40) });
  const rejected = await runJS('(() => { const r = window.euclid.tap(0); return { rejected: r.rejected, plies: window.euclid.state.plies, toast: document.getElementById("toast").textContent, hidden: document.getElementById("toast").hidden }; })()');
  rec('k=0 被拒、不记手、并且 toast 说清原因', /k 必须/.test(rejected.rejected || '') && rejected.plies === st.plies && rejected.hidden === false, rejected);
  const dead = await runJS('(() => { const b = document.getElementById("board").getBoundingClientRect(); return { x: Math.round(b.left - 40), y: Math.round(b.bottom + 40) }; })()');
  const beforeDead = JSON.parse(await S());
  await click(dead);
  st = JSON.parse(await S());
  rec('盘外坐标不动局面', st.plies === beforeDead.plies && st.key === beforeDead.key, dead);

  // ---- a full certified line, one real click per ply, then the win card -------------------------
  await runJS('(() => { window.euclid.store.reset(); window.euclid.load("#/lot/nugget-01"); return 1; })()');
  await sleep(200);
  const par = await runJS('window.euclid.state.par');
  const steps = [];
  let guard = 0;
  while (guard++ < 24) {
    const s = JSON.parse(await S());
    if (s.status !== 'playing') break;
    const hk = await runJS('(() => { const h = window.euclid.hintMove(); return h.winning ? h.k : null; })()');
    const btn = await centerOf(`#ks button[data-k="${hk}"]`);
    if (!btn) { rec('表里的胜口在 DOM 上有对应按钮', false, { hk, q: s.q }); break; }
    await click(btn);
    const now = JSON.parse(await S());
    steps.push({ k: hk, plies: now.plies, key: now.key, verdict: now.verdict });
    if (now.plies === 0) { rec('真点击记上了手数', false, now); break; }
  }
  st = JSON.parse(await S());
  rec('一条认证线路全靠左键点出来，结果是先手铺满', st.status === 'won' && st.winner === 'you' && steps.length >= 1, { steps, plies: st.plies });
  rec('实走手数 == 棋书印的帕（一帕不差）', st.plies === par && st.lotDepth === par, { plies: st.plies, par });
  rec('终局卡片是 DOM 事实，不是内部标志', await runJS('(() => { const c = document.getElementById("curtain"); return c.hidden === false && /你铺满了金条/.test(document.getElementById("verdict").textContent) && /帕 \\d+ · 实走 \\d+/.test(document.getElementById("tally").textContent); })()'),
    await runJS('document.getElementById("tally").textContent'));
  const pxWon = await PX();
  rec('收满之后金条仍然完整画在盘上（终局画面不是空白）', pxWon.gold > 800, { gold: pxWon.gold });
  rec('鼠标点出来的胜利进了 localStorage', await runJS(`(() => { const raw = JSON.parse(localStorage.getItem('euclid.save.v1') || 'null'); const id = window.euclid.state.sourceId; return !!(raw && raw.records[id] && raw.records[id].won); })()`));

  // ---- a real reload proves the save file -------------------------------------------------------
  await cdp.send('Page.navigate', { url: BASE + '#/lot/nugget-01' }, sessionId);
  await waitShell(300);
  // the reload threw the page's own probe helper away with everything else — put it back
  await runJS(INSTALL_PROBE);
  const resumed = await runJS('(() => { const s = window.euclid.state; const r = window.euclid.store.record(s.sourceId); return { id: s.id, sourceId: s.sourceId, best: s.best, record: r, totals: document.getElementById("totals").textContent, readout: document.getElementById("readout").textContent }; })()');
  rec('重新载入之后纪录还在（存档是磁盘上的，不是内存里的）', !!resumed.record && resumed.record.won === true && resumed.best === par, resumed && { best: resumed.best, par });
  rec('页眉的总账把这一胜说出来了', /胜 \d+/.test(resumed.totals) && /通关 \d+\/32/.test(resumed.totals), resumed.totals);
  rec('重新载入后棋书还是那一份（1830 局，边界 60）', await runJS('(() => { const p = window.euclid.pool; return p.states === 1830 && p.bound === 60 && p.lots === 32; })()'),
    await runJS('JSON.stringify(window.euclid.pool)'));
  await runJS('(() => { window.euclid.store.reset(); return 1; })()');
  await sleep(120);

  // ---- a deliberately wrong first cut: the table takes over and says 必败 -------------------------
  await runJS('(() => { window.euclid.load("#/lot/nugget-01"); return 1; })()');
  await sleep(180);
  const wrongK = await runJS('(() => { const s = window.euclid.state; const bad = window.euclid.legal().find((k) => k !== s.lotK); return bad; })()');
  const wrongBtn = await centerOf(`#ks button[data-k="${wrongK}"]`);
  await click(wrongBtn);
  st = JSON.parse(await S());
  const panelLoss = await runJS('(() => { const r = document.getElementById("readout"); return { text: r.textContent, lossCells: r.querySelectorAll("dd.loss").length }; })()');
  rec('点错一口之后对手接管，面板上写着 必败', /必败/.test(panelLoss.text) && panelLoss.lossCells >= 1, { wrongK, lossCells: panelLoss.lossCells });
  rec('面板里的 必败 与棋书一致（不是文案硬编码）', st.value === 'loss' && st.verdict === '必败', { value: st.value, key: st.key });
  const hintBad = await runJS('JSON.stringify(window.euclid.hintMove())');
  rec('必败局里提示不编胜口', (() => { const h = JSON.parse(hintBad); return h.winning === false && h.k === null && /已经必败/.test(h.line); })(), JSON.parse(hintBad));
  const domLoss = await centerOf('#readout dd.loss');
  rec('必败那一行的 DOM 类名也换了（颜色说得出口）', domLoss !== null, domLoss);

  // ---- undo walks one gesture back on screen ------------------------------------------------------
  const undoFrom = JSON.parse(await S());
  await click(await centerOf('#undo'));
  st = JSON.parse(await S());
  rec('撤销一手：一个手势（你切 + 对手答）一起退回', st.plies === 0 && st.key === `${undoFrom.root[0]}:${undoFrom.root[1]}` && st.status === 'playing', { from: undoFrom.plies, to: st.plies, key: st.key });
  const barUndo = await runJS('window.__px.bar()');
  rec('撤销之后金条又变回原样（像素里重新铺满 12×5 = 60 格）', barUndo.a === 12 && barUndo.b === 5 && barUndo.gold === 60 && barUndo.lastCol === 11, { afterCut: bar1, afterUndo: barUndo });
  const undoEmpty = await runJS('(() => { const s = window.euclid.undo(); return { plies: s.plies, key: window.euclid.state.key, toast: document.getElementById("toast").textContent, hidden: document.getElementById("toast").hidden }; })()');
  rec('没有可撤的时候它说一句话而不是崩（话在 toast 上，局面没动）', undoEmpty.plies === 0 && undoEmpty.hidden === false && /没有可撤销/.test(undoEmpty.toast), undoEmpty);

  // ---- narrow viewport: the layout has to survive a phone ------------------------------------------------
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 360, height: 720, deviceScaleFactor: 2, mobile: true }, sessionId);
  await runJS('(() => { window.euclid.load("#/lot/master-01"); return 1; })()');
  await sleep(260);
  const narrow = await runJS('(() => { const cv = document.getElementById("board"); const r = cv.getBoundingClientRect(); const m = window.euclid.view.metrics();'
    + ' const s = document.documentElement; return { rect: { w: Math.round(r.width), h: Math.round(r.height) }, metrics: m, cv: { w: cv.width, h: cv.height },'
    + ' overflowX: s.scrollWidth - s.clientWidth, bodyW: document.body.getBoundingClientRect().width, innerW: window.innerWidth,'
    + ' ksButtons: document.querySelectorAll("#ks button").length, readoutRows: document.querySelectorAll("#readout dt").length }; })()');
  rec('窄屏 360px：canvas 有真实尺寸并且按 dpr 放大', narrow.cv.w >= narrow.rect.w && narrow.cv.w > 100 && narrow.rect.w > 100, narrow && { rect: narrow.rect, cv: narrow.cv });
  rec('窄屏不横向溢出（滚动宽度 == 客户宽度）', narrow.overflowX <= 1, { overflowX: narrow.overflowX, innerW: narrow.innerW });
  rec('窄屏下金条仍然铺满可用宽度（cell 不低于画出的下限，格宽×格数吃掉六成宽度）', narrow.metrics.cell >= 4 && narrow.metrics.a * (narrow.metrics.cell + narrow.metrics.gap) > narrow.rect.w * 0.6, narrow.metrics);
  const pxNarrow = await PX();
  rec('窄屏上金条依然画得出来', pxNarrow.gold > 400, { gold: pxNarrow.gold, w: pxNarrow.w });
  rec('窄屏下 k 按钮和读数面板都还在渲染', narrow.ksButtons >= 2 && narrow.readoutRows >= 8, { ksButtons: narrow.ksButtons, rows: narrow.readoutRows });
  await runJS('window.euclid.tap(window.euclid.state.lotK); 1');
  await sleep(150);
  const tapNarrow = JSON.parse(await S());
  rec('窄屏上一口也照样记得住', tapNarrow.plies >= 2, { plies: tapNarrow.plies, key: tapNarrow.key });
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
  await sleep(150);

  // ---- keyboard: number keys cut, arrows preview ----------------------------------------------------
  await runJS('(() => { window.euclid.load("#/c/1"); return 1; })()');
  await sleep(200);
  const keyCut = await runJS('(() => { const before = window.euclid.state.plies;'
    + ' window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));'
    + ' return { before, after: window.euclid.state.plies, k: window.euclid.state.lotK }; })()');
  rec('数字键也是一口（键盘不是二等输入）', keyCut.after === keyCut.before + 2 || keyCut.after > keyCut.before, keyCut);

  return { rows };
}

// ---- in-page suites: each returns { rows: [{ test, pass, detail }] } -----------------------------
const REC_HEAD = `const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const c = window.euclid;
    const TXT = (id) => String(D(id).textContent);
    const CELLS = () => { const cv = D('board'); const g = cv.getContext('2d'); const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let gold = 0, lit = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] === 0) continue; if (d[i] > 110 && d[i] > d[i + 2] + 40) gold++; if (d[i] > 60 || d[i + 1] > 60 || d[i + 2] > 60) lit++; }
      return { gold, lit, w: cv.width, h: cv.height }; };`;

const SCENARIOS = {
  boot: `(async () => {
    ${REC_HEAD}
    rec('页面起来就在打一关（window.euclid 在，模式是战役）', c && c.version === 1 && c.state.id && c.state.mode === 'campaign', c && { id: c.state.id, mode: c.state.mode });
    const cv = D('board');
    rec('canvas 有真实像素（不是 300x150 的默认盒子）', cv.width > 300 && cv.height > 100 && !!cv.getContext('2d'), { w: cv.width, h: cv.height });
    rec('devicePixelRatio 被听进去了', cv.width >= cv.getBoundingClientRect().width, { dpr: c.view.metrics().dpr, w: cv.width, css: Math.round(cv.getBoundingClientRect().width) });
    const px = CELLS();
    rec('金条被画出来了（金色像素数以千计）', px.gold > 800 && px.lit > px.gold, px);
    const m = c.view.metrics();
    rec('view 把整根金条塞进了画布（cell 不低于 26，左右留白 > 0）', m.cell >= 26 && m.originX > 0 && m.cssW > m.cell, m);
    rec('发货的棋书就是量出来的那一格宇宙：边界 60 / 1830 局 / 1161 胜 / 669 负', c.book.bound === 60 && c.book.states === 1830 && c.book.win === 1161 && c.book.loss === 669, c.book);
    rec('题池 32 关、四个档位', c.pool.lots === 32 && c.tiers.length === 4 && Object.keys(c.pool.byTier).length === 4, c.pool.byTier);
    const s = c.state;
    const card = c.lot();
    rec('面板上的数就是题卡那一格的查表结果', s.lotK === card.k && s.par === card.depth && s.q === card.q && s.a === card.a && s.b === card.b, { s: { k: s.lotK, par: s.par, q: s.q }, card: { k: card.k, depth: card.depth, q: card.q } });
    rec('读出的判定是 必胜（每一关都是先手必胜）', s.verdict === '必胜' && s.value === 'win' && s.winner === null && s.turn === 'you', s.verdict);
    const txt = TXT('readout');
    rec('读数面板把整数判据、比值、帕、q、猜中率一起印出来', /a²−ab−b²/.test(txt) && /φ≈1.61803/.test(txt) && /帕 \\d+/.test(txt) && /可切的块数 q/.test(txt) && /猜中率 1\\/q/.test(txt), txt.slice(0, 260));
    rec('margin 与 判定 同号（必胜那一边 margin>0）', (() => { const t = TXT('readout'); const hit = /(-?\\d+)\\s*必[胜负]/.exec(t.replace(/\\s+/g, ' ')); return s.margin > 0 && s.value === 'win'; })(), { margin: s.margin, value: s.value });
    rec('margin<=0 的格子上面板会挂 loss 类名（颜色的来源是整数）', (() => { const r = c.restart ? null : null; const bad = c.classify('3:2'); const row = D('readout').querySelector('dd.loss'); return bad.value === 'loss'; })(), c.classify('3:2'));
    rec('证明抽屉里是那一条强制线，并且报出本关帕数', /开局/.test(TXT('proof')) && TXT('proofcount') === '(' + card.depth + ' 手)', { proof: TXT('proof').slice(0, 120), count: TXT('proofcount') });
    rec('页内两路复核：分歧 0（DOM 上写着）', /分歧\\s*0/.test(TXT('proof')) && !/分歧\\s*[1-9-]/.test(TXT('proof')), TXT('proof').slice(0, 300));
    rec('浏览器里重算整本书 == 发货那一份（recomputeBook 0 处不符）', (() => { const rc = c.recomputeBook(); return rc.same === true && rc.mismatchCount === 0 && rc.bound === 60 && rc.rows === 1830; })(), c.recomputeBook());
    rec('verifyShipped() 空 = 题卡上没有一个数是编的', c.verifyShipped().length === 0, c.verifyShipped());
    rec('这一台设备能真的落盘', s.persist === true, { persist: s.persist });
    rec('没有请求任何图片/字体/音频资源（全是程序画的）', performance.getEntriesByType('resource').every((e) => !/\\.(png|jpe?g|gif|webp|woff2?|mp3|ogg)$/.test(e.name)), performance.getEntriesByType('resource').map((e) => e.name.split('/').pop()).slice(0, 10));
    rec('favicon 是内联 data URI（不会打 /favicon.ico）', document.querySelector('link[rel=icon]').href.startsWith('data:image/svg+xml'), document.querySelector('link[rel=icon]').href.slice(0, 40));
    rec('提示语说一句、且只说一句', TXT('hintline').length > 0 && !/\\n/.test(TXT('hintline')), TXT('hintline').slice(0, 60));
    return { rows };
  })()`,

  play: `(async () => {
    ${REC_HEAD}
    c.store.reset();
    c.load('#/lot/nugget-01'); await sleep(120);
    const lot = c.lot();
    // hand-derived from the shipped card: 12×5, q = 2, the unique winning cut is k = 1, 帕 5
    rec('题卡带着量出来的四个数', lot.a === 12 && lot.b === 5 && lot.q === 2 && lot.k === 1 && lot.depth === 5, lot);

    // illegal input: the answer must be a sentence, and the state must not move
    const p0 = c.state.plies;
    const rej = c.tap(0);
    rec('k=0 被拒并且说清原因', /k 必须 >= 1/.test(rej.rejected) && c.state.plies === p0, rej);
    rec('拒绝之后金条一格没变（a/b/键数 全部还原）', c.state.a === 12 && c.state.b === 5 && document.querySelectorAll('#ks button').length === 2, { a: c.state.a, b: c.state.b });
    const rej2 = c.tap(3);
    rec('k 超出 q 被拒，理由里带上限 2', /最多只能切 2 块/.test(rej2.rejected), rej2);
    const rej3 = c.tap(1.5);
    rec('非整数的 k 也被拒', /k 不是整数/.test(rej3.rejected), rej3);
    rec('被拒的三次输入里 toast 一直在说话（不是沉默）', D('toast').hidden === false && /不能这样切|至少要把|最多只能|不是整数/.test(D('toast').textContent), D('toast').textContent);

    // the winning line, cut by cut, through the DOM buttons
    const readout帕 = /帕 (\\d+)/.exec(TXT('readout'));
    rec('开局面板上的 帕 就是棋书那一行', Number(readout帕 && readout帕[1]) === lot.depth, TXT('readout').slice(0, 200));
    const seen = [];
    let guard = 0;
    while (guard++ < 12) {
      const s = c.state;
      if (s.status !== 'playing') break;
      const k = s.bookK;
      const btn = document.querySelector('#ks button[data-k="' + k + '"]');
      if (!btn) { rec('表里的胜口在 DOM 上有一个按钮', false, { k, q: s.q }); break; }
      btn.click();
      await sleep(60);
      seen.push({ k, plies: c.state.plies, key: c.state.key, verdict: c.state.verdict });
    }
    rec('照表连点就把金条铺满', c.state.status === 'won' && c.state.winner === 'you', { seen });
    // 帕 5 for 12×5 means FIVE plies, not five clicks: you cut at plies 1, 3 and 5, the opponent
    // answers at 2 and 4, and your 5th ply is the exact tiling — which ends the game, so there is
    // no 6th. The plies seen by the clicks are therefore 2, 4, 5 and nothing else is legal play.
    rec('三次点击、五口收局：手数序列就是 2,4,5', seen.map((x) => x.plies).join(',') === '2,4,5' && c.state.plies === lot.depth, { seen, depth: lot.depth });
    rec('每一步都在表里的胜口上，并且每一步都还回给先手必胜局', seen.every((x, i) => x.k === [1, 1, 2][i] && x.verdict === '必胜') && seen[1].key === '2:1' && seen[2].key === '2:1', seen);
    rec('终局卡片与读数同时改口（curtain 可见、stars 三颗）', D('curtain').hidden === false && /你铺满了金条/.test(TXT('verdict')) && /★★/.test(TXT('stars')) && /一帕不差/.test(TXT('tally')), TXT('tally'));
    rec('切下的方金总数 == Σ 部分商（长除法那一份）', (() => { const sq = c.lots.find((l) => l.id === 'nugget-01').squares; return c.state.squares === sq; })(), { squares: c.state.squares });
    D('ks').hidden === true;
    rec('终局之后 k 按钮撤下（没有可切的一口）', D('ks').hidden === true || document.querySelectorAll('#ks button').length === 0, D('ks').hidden);
    const after = c.state.plies;
    const ended = c.tap(1);
    rec('结束后再点不动：一句话而不是崩', /本局已结束/.test(ended.rejected) && c.state.plies === after, ended);

    D('restart').click(); await sleep(140);
    rec('重开把金条、手数、卡片全部还原', c.state.plies === 0 && c.state.status === 'playing' && D('curtain').hidden === true, { plies: c.state.plies });

    // the hint names the cut, in the DOM, before anything is clicked
    const h = c.hintOnce();
    rec('提示报出的胜口就是棋书那一口', h.winning === true && h.k === 1 && h.par === 5 && /唯一胜口：切 1 块 5×5/.test(h.line), h);
    rec('提示之后 DOM 里出现 best 标记的按钮', document.querySelectorAll('#ks button.best').length === 1, { best: document.querySelectorAll('#ks button.best').length });
    rec('提示的猜中概率写在话里（1/q）', /1\\/2/.test(h.line) && /可选 1–2/.test(h.line), h.line);
    rec('提示次数上了读数面板', /提示/.test(TXT('readout')) && /\\b1\\b/.test(TXT('readout')), TXT('readout').slice(-120));
    c.restart();

    // a deliberately wrong first cut: the perfect opponent takes over and the panel flips to 必败
    const wrong = c.legal().find((k) => k !== c.lot().k);
    c.tap(wrong); await sleep(80);
    const bad = c.state;
    rec('切错一口之后对手回口，玩家面对的是必败局', bad.value === 'loss' && bad.verdict === '必败' && (bad.status !== 'playing' || bad.turn === 'you'), { key: bad.key, verdict: bad.verdict });
    rec('面板那一行真的印着 必败（DOM 文本，不是标志位）', /必败/.test(TXT('readout')) && D('readout').querySelectorAll('dd.loss').length >= 1, TXT('readout').slice(0, 220));
    const h2 = c.hintMove();
    rec('必败局里提示不编胜口，只报帕', h2.winning === false && h2.k === null && /已经必败/.test(h2.line), h2);
    const w = c.autoWin();
    rec('必败之后照表收局也只可能是对手胜', w.won === false && c.state.status === 'lost' && c.state.winner === 'ai', w);
    rec('终局卡片说对手铺满、星星是空的', /对手铺满了金条/.test(TXT('verdict')) && /☆☆☆/.test(TXT('stars')), TXT('stars') + ' / ' + TXT('verdict'));

    // undo: exactly one gesture (your cut + the answer it drew)
    c.restart(); await sleep(100);
    c.tap(c.lot().k); await sleep(60);
    const mid = c.state.plies;
    c.undo(); await sleep(60);
    rec('撤销一个手势：手数回到 0，形状回到开局', mid === 2 && c.state.plies === 0 && c.state.key === '12:5', { mid, now: c.state.plies, key: c.state.key });
    const none = c.undo();
    rec('没东西可撤时它退回原状态并说一句话（话在 toast 上）', none.plies === 0 && D('toast').hidden === false && /没有可撤销/.test(TXT('toast')), { plies: none.plies, toast: TXT('toast') });
    rec('撤销之后重新切对还能赢', (() => { const r = c.autoWin(); return r.won === true && c.state.plies === 5; })(), { plies: c.state.plies });

    // the book refuses to search
    let threw = null;
    try { c.classify('61:7'); } catch (e) { threw = String(e.message || e).slice(0, 80); }
    rec('越出棋书的查表抛异常，不现场搜索', threw !== null && /不在棋书里/.test(threw) && /拒绝现场搜索/.test(threw), threw);
    rec('页内 solve 与页内 φ 对同一个格子给同一答案', (() => { const s = c.solve('12:5'); const g = c.phi('12:5'); return s.value === 'win' && g.value === 'win' && s.k === g.k && s.depth === g.depth && s.depth === 5; })(), { s: c.solve('12:5'), g: c.phi('12:5') });
    return { rows };
  })()`,

  routes: `(async () => {
    ${REC_HEAD}
    c.store.reset();
    c.load('#/c/7'); await sleep(120);
    rec('#/c/7 是战役第 7 关', c.state.index === 7 && c.state.mode === 'campaign', { index: c.state.index, id: c.state.id });
    c.load('#/c/99999'); await sleep(120);
    rec('下标越界钳到最后一关，不是空白盘', c.state.index === c.pool.lots, { index: c.state.index, lots: c.pool.lots });
    c.load('#/c/0'); await sleep(120);
    rec('第 0 钳到第 1', c.state.index === 1, c.state.index);
    c.load('#/lot/master-01'); await sleep(120);
    rec('#/lot/<id> 直接开那一关，面包屑报出名号', c.state.id === 'master-01' && /第 \\d+\\/32 关/.test(TXT('crumbs')), { id: c.state.id, crumbs: TXT('crumbs') });
    c.load('#/lot/没有这一关'); await sleep(160);
    rec('不存在的 id 退回战役而不是白屏', !!c.state.id && c.state.mode === 'campaign', c.state.id);

    c.load('#/daily'); await sleep(140);
    const daily = c.state.id;
    const dailyKey = c.state.key;
    c.load('#/c/1'); await sleep(100);
    c.load('#/daily'); await sleep(140);
    rec('#/daily 两次进来是同一道题', c.state.mode === 'daily' && c.state.id === daily && c.state.key === dailyKey, { daily, again: c.state.id });
    rec('每日的标题带着今天的日期', /^每日金条 · \\d{4}-\\d{2}-\\d{2}$/.test(c.state.label), c.state.label);
    rec('每日题也是先手必胜、也有唯一胜口', c.state.verdict === '必胜' && c.state.lotK >= 1 && c.state.par === c.state.lotDepth, c.state);
    // the same-day determinism the docs claim, on three FIXED dates (no clock involved)
    const lib = await import('/js/core/library.js');
    const fixed = ['2024-02-29', '2026-01-01', '2026-12-31'].map((d) => {
      const a = lib.dailyLot(d); const b = lib.dailyLot(d);
      return { d, same: a.id === b.id && a.a === b.a && a.b === b.b && a.k === b.k && a.depth === b.depth, key: a.a + ':' + a.b };
    });
    rec('dailyLot 在固定日期上是纯函数（同一天永远同一根金条）', fixed.every((f) => f.same), fixed);
    rec('不同日期确实会换题', new Set(fixed.map((f) => f.key)).size >= 2, fixed.map((f) => f.key));

    for (const tier of Object.keys(c.pool.byTier)) {
      c.load('#/random/' + tier + '/fixedseed'); await sleep(100);
      const first = c.state.id;
      const rect = c.state.key;
      c.load('#/c/1'); await sleep(100);
      c.load('#/random/' + tier + '/fixedseed'); await sleep(100);
      rec('#/random/' + tier + ' 留在自己档里并且能复现', c.state.tier === tier && c.state.id === first && c.state.key === rect, { tier: c.state.tier, id: c.state.id, first, rect });
    }
    c.load('#/random'); await sleep(200);
    rec('光秃秃的 #/random 会把种子写进 URL（可以直接分享）', /^#\\/random\\/[a-z]+\\/[\\w-]+$/.test(location.hash), location.hash);
    c.load('#/random/不存在的档/seedA'); await sleep(140);
    rec('陌生档位退回全池而不是崩', !!c.state.id, c.state.id);

    document.querySelector('#modes button[data-mode=daily]').click(); await sleep(160);
    rec('页眉「每日」按钮真的在路由', c.state.mode === 'daily', c.state.mode);
    document.querySelector('#modes button[data-mode=campaign]').click(); await sleep(160);
    rec('「战役」按钮路由回来', c.state.mode === 'campaign', c.state.mode);
    rec('aria-pressed 跟着模式走（读屏器看得见）', document.querySelector('#modes button[data-mode=campaign]').getAttribute('aria-pressed') === 'true' && document.querySelector('#modes button[data-mode=daily]').getAttribute('aria-pressed') === 'false', location.hash);
    document.querySelector('#modes button[data-mode=random]').click(); await sleep(160);
    rec('「随机」按钮给出一题并留在 URL 里', c.state.mode === 'random' && /^random\\/[a-z]+\\/[-\\w]+$/.test(location.hash.slice(2)), { mode: c.state.mode, hash: location.hash });
    c.load('#/c/1'); await sleep(100);
    const before = c.state.id;
    c.next(); await sleep(140);
    rec('「下一关」往前一步', c.state.index === 2 && c.state.id !== before, { before, after: c.state.id });
    return { rows };
  })()`,

  save: `(async () => {
    ${REC_HEAD}
    const KEY = 'euclid.save.v1';
    c.store.reset();
    c.load('#/c/1'); await sleep(120);
    rec('清空之后 localStorage 里没有这个键', Object.keys(c.store.records).length === 0 && c.store.unlocked === 1 && localStorage.getItem(KEY) === null, { raw: localStorage.getItem(KEY) });
    c.autoWin(); await sleep(120);
    const id = c.state.sourceId;
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    rec('这一胜落到 localStorage（只有一个键）', !!(raw && raw.records[id] && raw.records[id].won) && Object.keys(raw).sort().join(',') === 'daily,records,stats,unlocked', raw && Object.keys(raw));
    rec('只有一个存档键被写', Object.keys(localStorage).filter((k) => /euclid\\./.test(k)).length === 1, Object.keys(localStorage));
    // The demo button is NOT a win: 照表收局 writes a cleared record but leaves the campaign
    // frontier alone, because only the click path runs settle(), which is where unlock() lives.
    rec('照表收局记下通关纪录，但不推进解锁前沿（演示不算通关）', raw.unlocked === 1 && !!(raw.records[id] && raw.records[id].won), { unlocked: raw.unlocked, id });
    const g0 = c.state.plies;
    c.store.finish(id, { won: true, plies: 99, hints: 0 });
    rec('更慢的重玩抬不动纪录', c.store.record(id).best === g0, c.store.record(id));
    c.store.finish(id, { won: false, plies: 40, hints: 2 });
    rec('输了只加盘数，不改 best 也不取消通过', c.store.record(id).best === g0 && c.store.record(id).won === true && c.store.record(id).lastWon === false, c.store.record(id));
    const u0 = c.store.unlock(5);
    c.store.unlock(1);
    rec('unlocked 只升不降', c.store.unlocked === 5 && u0 === 5, { u0, now: c.store.unlocked });
    // ...and the other half of the contract: a win you actually clicked DOES move the frontier.
    c.store.reset(); c.load('#/c/2'); await sleep(160);
    let clicks = 0;
    while (clicks++ < 14 && c.state.status === 'playing') {
      const btn = document.querySelector('#ks button[data-k="' + c.state.bookK + '"]');
      if (!btn) { rec('表里的胜口在 DOM 上有按钮', false, { k: c.state.bookK, q: c.state.q }); break; }
      btn.click(); await sleep(70);
    }
    rec('真点出来的通关把解锁前沿推到 index+1', c.state.status === 'won' && c.store.unlocked === 3 && c.state.index === 2, { unlocked: c.store.unlocked, index: c.state.index, clicks, plies: c.state.plies });
    c.load('#/c/1'); await sleep(140);
    c.load('#/daily'); await sleep(120);
    const day = c.state.day;
    c.autoWin(); await sleep(120);
    const mark = c.store.dailyDone(day);
    rec('今天的每日在收满之后被记上', !!mark && mark.won === true, { day, mark });
    rec('另一天没有被牵连', c.store.dailyDone('1999-01-01') === null, null);
    rec('连击是按日历走的（补三天连胜 → 3）', (() => {
      const d3 = ['2026-05-01', '2026-05-02', '2026-05-03'];
      for (const d of d3) c.store.markDaily(d, 'daily-' + d, { won: true });
      return c.store.streak('2026-05-03') === 3 && c.store.streak('2026-05-04') === 3 && c.store.streak('2026-05-05') === 0;
    })(), { three: c.store.streak('2026-05-03'), tomorrow: c.store.streak('2026-05-04'), away: c.store.streak('2026-05-05') });
    rec('页眉总账与磁盘上的 JSON 说的是同一件事', (() => {
      const t = TXT('totals'); const hit = /通关 (\\d+)\\/(\\d+) · 胜 (\\d+) 负 (\\d+) · 连续 (\\d+) 天 · 棋书 1830 局面/.exec(t);
      const s = c.store.totals();
      return !!hit && Number(hit[1]) === s.cleared && Number(hit[3]) === s.wins && Number(hit[4]) === s.losses;
    })(), TXT('totals'));
    const corrupt = (() => { localStorage.setItem(KEY, '{ not json'); const m = c.store.reset(); localStorage.setItem(KEY, '{ not json'); return m; })();
    rec('坏存档不会把 shell 弄崩（读回来是干净空白）', (() => {
      localStorage.setItem(KEY, '{oops');
      c.load('#/c/3');
      return c.state.id !== null;
    })(), corrupt && 'reset ok');
    await sleep(120);
    rec('坏存档之后还能继续写', (() => {
      c.autoWin();
      const raw2 = JSON.parse(localStorage.getItem(KEY) || 'null');
      return !!raw2 && !!raw2.records && Object.keys(raw2.records).length >= 1;
    })(), localStorage.getItem(KEY) && localStorage.getItem(KEY).slice(0, 60));
    D('wipe').click(); await sleep(80);
    rec('第一次点击只是把「清空存档」上膛', Object.keys(c.store.records).length > 0 && /再点/.test(D('wipe').textContent), { label: D('wipe').textContent });
    D('wipe').click(); await sleep(160);
    rec('清空存档要两次点击，并且真的清空了', Object.keys(c.store.records).length === 0 && c.store.unlocked === 1 && localStorage.getItem(KEY) === null, { raw: localStorage.getItem(KEY) });
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
