// test/frameparity.test.mjs — 关卡内的三档帧率对拍，加上钉在同一把尺上的阴性对照。
//
// 为什么这份文件必须存在：BRIEF_COS §3 要的读数是"真进关卡之后，30/60/120Hz 喂同一段虚拟时长，
// 逐字段对拍"。官方量具 cos_frame_probe.js 用的是 `vm.runInContext(源码)`，而本仓入口是
// `<script type="module">`（package.json 也标了 type:module），于是它三档全打
// `SyntaxError: Cannot use import statement outside a module` ⇒ "结论：无法比对"。尺子读不到状态，
// 判据就无法复验。这里把整具外壳（js/main.js + 路由 + 会话时钟 + HUD 闸门）挂在一个最小 DOM 桩上
// 跑起来，真的进到 8×3 那一局里，再按三档喂帧。
//
// 对拍的对象是外壳里唯一真的随时间自己走的东西：会话时钟上的两个倒计时 —— 提示条 2600ms
// (TOAST_MS) 与清空存档的二次确认 4000ms (WIPE_MS)。本仓没有逐帧物理（判定来自查表，点击即定），
// 所以"关卡内是否帧率无关"这个问题，可测量的形式就是：**同一颗种子、同一段阶梯，倒计时在第几毫秒
// 的墙钟上到期，三档是否一致**。用墙钟而不是帧数作判据是关键 —— 用帧数当时间用的实现，三档帧数
// 必然差 4 倍，而到期墙钟时刻差 4 倍正是它的红。
//
// 三条防"尺子空跑"的钉子：
//   1. 到期时刻的 sim 读数必须贴着 2600 / 4000（一帧以内），否则三档全等也可能只是"什么都没发生"；
//   2. 倒计时烧完之后驱动必须停车：空转 20 帧，sim 一格都不许涨（js/hud.js 只在 pending>0 时续挂）；
//   3. §6 的阴性对照：把 js/core/clock.js 的 `simMs += elapsed` 改成 `simMs += 1`（在临时副本里改，
//      产品码不动），同一把尺必须变红（比值 > 3.6）。实测红在 4.0000。
//
// 档位之间不共享起点：simMs 是全外壳共享的单调量，每一档开跑前先把上一条阶梯留下的倒计时烧干净，
// 否则两档的账会混成一支假绿（变异组实测就是这么暴露的）。
//   node test/frameparity.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RATES = [30, 60, 120];
const SEED = 20261005;
const TOAST_MS = 2600;        // 与 js/main.js 的 TOAST_MS 同值
const WIPE_MS = 4000;         // 与 js/main.js 的 WIPE_MS 同值
const IDLE_FRAMES = 20;

const ratio = (xs) => Math.max(...xs) / Math.min(...xs);
const nums = (xs, f = 2) => xs.map((v) => (v === null ? 'null' : v.toFixed(f))).join(' / ');

// 同一颗 LCG 喂三档：帧间抖动才可复现，档与档之间的差异只能来自"时间怎么累加"。
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// 桩要照 index.html 真的建：把每个带 id 的标签上声明的属性原样搬进桩元素（aria-pressed、role、
// aria-live、hidden 都在里面）。否则第 5 支断言量到的是桩的默认值，产品写成什么样都测不出来。
const HTML = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const attrs = new Map();
  for (const m of html.matchAll(/<([a-z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const idm = /\bid="([^"]+)"/.exec(m[2]);
    if (!idm) continue;
    const a = {};
    for (const p of m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) a[p[1]] = p[2] === undefined ? '' : p[2];
    attrs.set(idm[1], a);
  }
  return { attrs, get: (id) => attrs.get(id) || {}, ariaPressed: new Map([...attrs].filter(([, a]) => 'aria-pressed' in a).map(([id, a]) => [id, a['aria-pressed']])) };
})();
let liveRegion = null;

// ---------------------------------------------------------------- 外壳的 DOM 桩
// 只够 main.js / view.js / hud.js / storage.js / pwa.js 真的跑起来：它们碰到的全局一共就这些
// （document.getElementById、canvas 2d、localStorage、matchMedia、navigator.clipboard、rAF）。
// 时钟源由测试决定：requestAnimationFrame 只把回调塞进队列，一帧何时来、带什么时标，全在 ladder 手里。
function installShellEnv() {
  const listeners = new Map();            // target -> type -> [{fn, once}]
  const on = (target) => (type, fn, opts = {}) => {
    const m = listeners.get(target) || new Map();
    m.set(type, (m.get(type) || []).concat({ fn, once: !!opts.once }));
    listeners.set(target, m);
  };
  const fire = (target, type, ev = {}) => {
    const ev2 = Object.assign({ type, defaultPrevented: false, target }, ev);
    ev2.preventDefault = () => { ev2.defaultPrevented = true; };
    ev2.stopPropagation = () => {};
    for (const e of ((listeners.get(target) || new Map()).get(type) || []).slice()) e.fn(ev2);
    return ev2;
  };

  const raf = [];
  const frames = (ts) => { const q = raf.splice(0, raf.length); for (const cb of q) cb(ts); return q.length; };

  const gradient = () => ({ addColorStop() {} });
  // 描边矩形要被量到：reduceMotion 那条判据的证据就是"切块预览的轮廓到底偏移了几个像素"，
  // 全吞成空函数的桩只能证明"画过"，证明不了"画在哪"。
  const strokes = [];
  const ctxHard = {
    measureText: () => ({ width: 8 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createPattern: () => ({ setTransform() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    strokeRect: (x, y, w, h) => { strokes.push({ x, y, w, h }); },
  };
  const makeCtx = () => new Proxy(ctxHard, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? () => {} : undefined)),
    set: () => true,
  });

  const bag = new Map();
  const localStorage = {
    getItem: (k) => (bag.has(k) ? bag.get(k) : null),
    setItem: (k, v) => { bag.set(k, String(v)); },
    removeItem: (k) => { bag.delete(k); },
    clear: () => bag.clear(),
    key: (i) => [...bag.keys()][i] ?? null,
    get length() { return bag.size; },
  };

  const els = new Map();
  // index.html 里 #board 是 <canvas>：getElementById 得按真实 id 给它 CANVAS 形状，
  // 否则 view.js 拿到一个没有 getContext 的 DIV，外壳在挂载阶段就炸。
  const TAG_BY_ID = { board: 'CANVAS', tutnever: 'INPUT' };
  const makeEl = (id, tag = TAG_BY_ID[id] || 'DIV') => {
    const node = {};
    Object.assign(node, {
      id, tagName: tag, hidden: false, checked: false, value: '', textContent: '', innerHTML: '',
      dataset: {}, style: { setProperty() {}, removeProperty() {} }, attrs: {}, children: [],
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
        toggle(c, v) { const want = v === undefined ? !this._s.has(c) : !!v; if (want) this._s.add(c); else this._s.delete(c); return want; },
        contains(c) { return this._s.has(c); },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      addEventListener: on(node),
      removeEventListener: () => {},
      appendChild(c) { this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      closest: () => null,
      querySelectorAll: () => [],
      focus() {},
      blur() {},
      click: (ev) => fire(node, 'click', Object.assign({ target: node }, ev)),
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 360, bottom: 240, width: 360, height: 240, x: 0, y: 0 }),
    });
    if (tag === 'CANVAS') {
      node.width = 360; node.height = 240;
      const ctx = makeCtx();
      node.getContext = () => ctx;
    }
    const declared = HTML.get(id);
    node.attrs = Object.assign({}, declared);
    if ('hidden' in declared) node.hidden = true;
    node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
    if (id === 'toast') {
      liveRegion = { role: node.attrs.role || null, live: node.attrs['aria-live'] || null, hidden: node.hidden };
    }
    return node;
  }
  const getEl = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  // render() 会对模式条上的三档按钮逐个 setAttribute；空数组就是一支没画出来的选中态。
  const modeBtns = ['campaign', 'daily', 'random'].map((m) => {
    const b = makeEl('mode-' + m, 'BUTTON');
    b.dataset.mode = m;
    return b;
  });
  getEl('modes').querySelectorAll = (sel) => (sel === 'button' ? modeBtns : []);

  const param = () => ({
    value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
    setTargetAtTime() {}, cancelScheduledValues() {},
  });
  class AudioContextStub {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sampleRate = 48000; }
    createOscillator() { return { type: 'sine', frequency: param(), connect() {}, disconnect() {}, start() {}, stop() {} }; }
    createGain() { return { gain: param(), connect() {}, disconnect() {} }; }
    createBuffer() { return { getChannelData: () => new Float32Array(64) }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }

  const documentStub = {
    documentElement: { style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
    fullscreenElement: null,
    exitFullscreen: () => Promise.resolve(),
    getElementById: getEl,
    createElement: (t) => makeEl('created-' + t, String(t).toUpperCase()),
    addEventListener: on('document'),
    removeEventListener: () => {},
    body: makeEl('body'),
  };

  // 可翻转的 MQL：matches 恒 false 的桩造不出"系统偏好中途改了"这条判据 —— 翻转必须真的把
  // change 回调打出去，并且按媒体查询分别记账（本仓只有 reduced-motion 一条订阅）。
  const mqls = [];
  const matchMedia = (q) => {
    const m = {
      media: String(q), matches: false, _h: [],
      addEventListener(t, cb) { if (t === 'change') this._h.push(cb); },
      removeEventListener(t, cb) { this._h = this._h.filter((f) => f !== cb); },
      addListener(cb) { this._h.push(cb); },
      removeListener(cb) { this._h = this._h.filter((f) => f !== cb); },
    };
    mqls.push(m);
    return m;
  };
  const setReduceMotion = (v) => {
    let fired = 0;
    for (const m of mqls) {
      if (!/reduced-motion/.test(m.media) || m.matches === !!v) continue;
      m.matches = !!v;
      for (const cb of m._h.slice()) { fired++; cb({ media: m.media, matches: !!v }); }
    }
    return fired;
  };

  const globals = {
    document: documentStub,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    matchMedia,
    requestAnimationFrame: (cb) => { raf.push(cb); return raf.length; },
    cancelAnimationFrame: () => {},
    AudioContext: AudioContextStub,
    webkitAudioContext: AudioContextStub,
    PointerEvent: function PointerEvent() {},
    localStorage,
    navigator: { clipboard: { writeText: () => Promise.resolve() }, serviceWorker: undefined, userAgent: 'node-harness' },
    location: { protocol: 'http:', hash: '#/c/1', origin: 'http://127.0.0.1', pathname: '/', href: 'http://127.0.0.1/', assign() {}, replace() {}, reload() {} },
    history: { pushState() {}, replaceState() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#c9a227' }),
    addEventListener: on('window'),
    removeEventListener: () => {},
    Image: function Image() { return { addEventListener() {} }; },
  };
  for (const [k, v] of Object.entries(globals)) {
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  }
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true, configurable: true });

  return { getEl, frames, raf, fire, documentStub, localStorage, strokes, setReduceMotion, mqls };
}

// 真外壳：DOM 桩装上之后 import 仓里的 js/main.js（它是这一页唯一的入口）。
async function bootShell(mainPath) {
  const env = installShellEnv();
  const sink = [];
  const realLog = console.log;
  console.log = (...a) => sink.push(a.join(' '));        // 外壳启动时打一行 [log]，别混进对拍表格
  try {
    await import(pathToFileURL(mainPath).href);
  } finally {
    console.log = realLog;
  }
  return { env, boot: sink.join(' / '), api: globalThis.euclid };
}

// ---------------------------------------------------------------- 阶梯
// 一档一条阶梯：先把上一条阶梯留下的倒计时烧干净（simMs 是共享的单调量，起点不干净就是假绿），
// 再"排确认窗口 → 提示一条"，然后按这一档的帧长喂 rAF，直到两枚倒计时都到期。
function ladder(shell, hz, cursor) {
  const { env, api } = shell;
  const dt = 1000 / hz;
  const rnd = lcg(SEED);
  const step = () => { cursor.ts += dt + (rnd() - 0.5) * dt * 0.5; env.frames(cursor.ts); cursor.frames++; };

  let guard = 0;
  while (api.pending() > 0 && guard++ < 60_000) step();          // 排空：不排就会把两档的账混起来

  api.restart();
  env.getEl('toast').hidden = true;
  env.getEl('wipe').textContent = '清空存档';

  const wall0 = cursor.ts;
  const sim0 = api.simMs();
  const frames0 = cursor.frames;
  env.getEl('wipe').click();          // 排下 WIPE_MS 的二次确认窗口（顺带把 toast 亮起来）
  api.hintOnce();                     // 再排下 TOAST_MS 的提示条：同一个 toast 槽，两枚独立倒计时
  const armedToast = env.getEl('toast').hidden === false;

  let toastOffWall = null, toastOffSim = null, toastOffFrames = null;
  let wipeOffWall = null, wipeOffSim = null;
  while (cursor.ts - wall0 <= 200_000) {
    step();
    const sim = api.simMs() - sim0;
    if (toastOffWall === null && env.getEl('toast').hidden) { toastOffWall = cursor.ts - wall0; toastOffSim = sim; toastOffFrames = cursor.frames - frames0; }
    if (wipeOffWall === null && env.getEl('wipe').textContent === '清空存档') { wipeOffWall = cursor.ts - wall0; wipeOffSim = sim; }
    if (toastOffWall !== null && wipeOffWall !== null && api.pending() === 0) break;
  }

  // 到期之后再空转 IDLE_FRAMES 帧：驱动该停车了，sim 一格都不许动。
  const parkedFrom = api.simMs();
  for (let i = 0; i < IDLE_FRAMES; i++) { cursor.ts += dt; env.frames(cursor.ts); }
  const parkGap = api.simMs() - parkedFrom;

  const s = api.state;
  return {
    hz, armedToast, toastOffWall, toastOffSim, toastOffFrames, wipeOffWall, wipeOffSim,
    parkGap, pending: api.pending(), frames: cursor.frames - frames0,
    bar: `${s.a}×${s.b}`, plies: s.plies, hints: s.hints, status: s.status, kPreview: s.kPreview,
  };
}

// 三档跑同一段动作串：着法由棋书给（api.legal / api.tap），与帧率无关 ⇒ 终局必须逐字相同。
function playthrough(shell) {
  const { api } = shell;
  api.restart();
  const seen = [];
  for (let ply = 0; ply < 40; ply++) {
    const st = api.state;
    if (st.status !== 'playing') break;
    const legal = api.legal();
    const k = st.turn === 'you' ? Math.min(2, legal[legal.length - 1]) : legal[legal.length - 1];
    const r = api.tap(k);
    seen.push(`${k}:${api.state.a}x${api.state.b}${r.rejected ? '!rej' : ''}`);
  }
  const st = api.state;
  return { line: seen.join(','), status: st.status, plies: st.plies, squares: st.squares, bar: `${st.a}×${st.b}`, winner: st.winner };
}

const live = await bootShell(path.join(ROOT, 'js/main.js'));
// 开局状态要在任何测量动作之前取：后面的阶梯与着法串会把这一局打到终局，读到的就不是"进没进关卡"。
const bootState = { status: live.api.state.status, mode: live.api.state.mode, bar: `${live.api.state.a}×${live.api.state.b}`, id: live.api.state.id };
const cursor = { ts: 1000, frames: 0 };      // 沙箱时钟从 1000ms 起：0 会被 lastTime 哨兵吃掉一帧
const runs = RATES.map((hz) => ladder(live, hz, cursor));
const playthree = RATES.map((hz) => playthrough(live));

const toastWall = runs.map((r) => r.toastOffWall);
const wipeWall = runs.map((r) => r.wipeOffWall);
const toastSim = runs.map((r) => r.toastOffSim);
const wipeSim = runs.map((r) => r.wipeOffSim);

// ---------------------------------------------------------------- 1 外壳真的进得了关卡
test('frameparity: 真外壳在 node 里进到了关卡里（status=playing，harness 字段读得到）', () => {
  ok(live.api, 'window.euclid 没挂出来 ⇒ 任何探针都读不到本仓状态');
  eq(bootState.status, 'playing', `开局必须真的在进行中（读到 ${bootState.status} 就是在量标题态）`);
  eq(bootState.mode, 'campaign');
  eq(bootState.bar, '8×3', `默认关 #/c/1 的金条尺寸，实测 ${bootState.bar}`);
  console.log(`  [对拍] 进关 ${bootState.id} ${bootState.bar} status=${bootState.status}`);
  ok(live.boot.includes('分歧 0'), `两条路线在页内复核应当零分歧，实测：${live.boot}`);
});

// ---------------------------------------------------------------- 2 三档墙钟一致
test('frameparity: 提示条 2600ms 在 30/60/120Hz 下同一墙钟时刻消失（比值 ≤ 3.0）', () => {
  eq(toastWall.every((v) => v !== null), true, `三档都得真的让提示条消失，实测 ${nums(toastWall)}`);
  const rt = ratio(toastWall);
  ok(rt <= 3.0, `墙钟到期时刻=${nums(toastWall)} 比值 ${rt.toFixed(4)} 应在探针边界（3.0）以内`);
  console.log(`  [对拍] 提示条墙钟 ${nums(toastWall)} 比值 ${rt.toFixed(4)}`);
});

test('frameparity: 确认窗口 4000ms 同样三档一致（比值 ≤ 3.0）', () => {
  eq(wipeWall.every((v) => v !== null), true, `三档都得真的收回确认窗口，实测 ${nums(wipeWall)}`);
  const rt = ratio(wipeWall);
  ok(rt <= 3.0, `墙钟到期时刻=${nums(wipeWall)} 比值 ${rt.toFixed(4)} 应 ≤ 3.0`);
  console.log(`  [对拍] 确认窗口墙钟 ${nums(wipeWall)} 比值 ${rt.toFixed(4)}`);
});

// ---------------------------------------------------------------- 3 反空跑：读数真的随虚拟时长推进
test('frameparity: 到期时刻的 sim 读数贴着 2600 / 4000（一帧以内）—— 三档全等不是因为什么都没发生', () => {
  for (let i = 0; i < RATES.length; i++) {
    const oneFrame = 1000 / RATES[i];
    ok(Math.abs(toastSim[i] - TOAST_MS) <= oneFrame + 1,
       `${RATES[i]}Hz 提示条开火在 sim=${toastSim[i].toFixed(2)}，应贴着 ${TOAST_MS}（±一帧 ${oneFrame.toFixed(1)}）`);
    ok(Math.abs(wipeSim[i] - WIPE_MS) <= oneFrame + 1,
       `${RATES[i]}Hz 确认窗口开火在 sim=${wipeSim[i].toFixed(2)}，应贴着 ${WIPE_MS}`);
  }
  console.log(`  [对拍] 到期 sim 提示条 ${nums(toastSim)} / 确认窗口 ${nums(wipeSim)}`);
});

test('frameparity: 倒计时烧完之后驱动停车 —— 空转 ' + IDLE_FRAMES + ' 帧 sim 一格不涨', () => {
  eq(runs.every((r) => r.pending === 0), true, `收尾 pending 应为 0，实测 ${nums(runs.map((r) => r.pending), 0)}`);
  eq(runs.every((r) => r.parkGap === 0), true, `空闲里 sim 不该走，实测 ${nums(runs.map((r) => r.parkGap))}`);
  // 帧数当然按档位线性差 —— 这一支不参与判定，只是说明"为什么判据必须取墙钟而不是帧数"。
  const frameRatio = ratio(runs.map((r) => r.toastOffFrames));
  ok(frameRatio > 3.6, `三档到达同一时刻的帧数应差约 4 倍（实测 ${frameRatio.toFixed(4)}），否则阶梯根本没在跑`);
  console.log(`  [对拍] 帧数 ${nums(runs.map((r) => r.toastOffFrames), 0)}（比值 ${frameRatio.toFixed(4)}，随帧率线性，不参与判定）`);
});

test('frameparity: 三档的关卡不变量逐字相同（同一段着法串，与喂帧速度无关）', () => {
  const lines = playthree.map((p) => p.line);
  eq(new Set(lines).size, 1, `三档着法串必须逐字相同，实测 ${lines.map((l) => l.length).join(' / ')}`);
  const finals = playthree.map((p) => `${p.bar}|${p.status}|plies=${p.plies}|squares=${p.squares}|winner=${p.winner}`);
  eq(new Set(finals).size, 1, `三档终局必须相同，实测 ${finals.join(' vs ')}`);
  ok(finals[0].includes('squares='), '终局读数没量到切下的方金数');
  console.log(`  [对拍] 三档终局 ${finals[0]}（每一档都相同）`);
});

// ---------------------------------------------------------------- 4 重开复位的是什么
// §2 要求"重开把时钟、缓冲、粒子、玩家位置、临时增益全部复位"。本仓没有粒子与玩家位置，
// 但同样的坑在这里成立：重开漏掉缓存，就会有一刀预览、一枚提示条、一个临时增益跨过这一局。
// 两个方向都要钉住：这一局的状态必须归零；设备级的会话时钟与它上面的倒计时**不该**被归零
// （提示条是"这条信息活 2600 毫秒"，与重开无关；把它一起 cancel 掉，用户按 R 就看到一条凭空消失的提示）。
test('frameparity: 重开复位的是真状态 —— 预览/提示数/手数/棋谱归零，会话时钟不被一局带走', () => {
  const api = live.api;
  api.restart();
  api.hintOnce();                                   // 手上留一刀预览 + 一枚 2600ms 的提示条
  const shot = (s) => ({ a: s.a, b: s.b, plies: s.plies, hints: s.hints, kPreview: s.kPreview, turn: s.turn, history: s.history.length, status: s.status });
  const dirty = shot(api.state);
  ok(dirty.kPreview !== null && dirty.hints > 0, `脏状态没造出来（${JSON.stringify(dirty)}），后面的归零就是空跑`);
  const simBefore = api.simMs();
  const pendingBefore = api.pending();
  api.restart();
  const clean = shot(api.state);
  eq([clean.kPreview, clean.plies, clean.hints, clean.history], [null, 0, 0, 0],
     `重开之后残留 ${JSON.stringify({ before: dirty, after: clean })}`);
  eq([clean.a, clean.b], [dirty.a, dirty.b], '重开是回到同一根金条，不是换一局');
  eq(clean.status, 'playing');
  eq(live.env.getEl('toast').hidden, false, '重开不许把已经排下的提示条偷偷取消');
  eq(api.pending(), pendingBefore, '倒计时该还在，只是这一局的账清了');
  for (let i = 0; i < 5; i++) { cursor.ts += 16.7; live.env.frames(cursor.ts); }
  ok(api.simMs() > simBefore, `会话时钟该继续走（${simBefore} → ${api.simMs()}），重开不该把它抹成 0`);
  console.log(`  [重开] 脏 ${JSON.stringify(dirty)} → 净 ${JSON.stringify(clean)}，sim ${simBefore.toFixed(1)} → ${api.simMs().toFixed(1)}`);
});

// ---------------------------------------------------------------- 5 辅助技术读得到系统条
// 系统条的四个开关与 toast 是同一层：状态靠 aria-pressed 表达、反馈靠 live region 播报。
// 缺任何一支，"已静音 / 已暂停"对屏幕阅读器就根本不存在 —— 判据写在 DOM 上，量也必须量 DOM。
test('frameparity: #toast 是 live region，系统条的按压态真的写在 aria-pressed 上', () => {
  ok(liveRegion, 'DOM 桩没量到 #toast 的标签');
  eq(liveRegion.live, 'polite', `aria-live 应为 polite，实测 ${liveRegion.live}`);
  eq(liveRegion.role, 'status', `role 应为 status，实测 ${liveRegion.role}`);
  eq(liveRegion.hidden, true, '开局不该有一条待播的旧文案');

  const pause = live.env.getEl('pause');
  eq(HTML.ariaPressed.get('pause'), 'false', 'index.html 里 #pause 的初值必须是 false（桩照它建）');
  eq(pause.getAttribute('aria-pressed'), 'false');
  live.env.fire('window', 'keydown', { key: ' ', target: live.env.getEl('hintline') });
  eq(pause.getAttribute('aria-pressed'), 'true', `按 Space 之后 aria-pressed 要翻过来，实测 ${pause.getAttribute('aria-pressed')}`);
  eq(live.env.getEl('paused').hidden, false, '暂停面板该真的露出来');
  live.env.fire('window', 'keydown', { key: ' ', target: live.env.getEl('hintline') });
  eq(pause.getAttribute('aria-pressed'), 'false', '再按一次要翻回去');
  console.log(`  [a11y] #toast role=${liveRegion.role} aria-live=${liveRegion.live} · #pause aria-pressed false→true→false`);
});

// ---------------------------------------------------------------- 6 reduceMotion 是活的
// §2 要的是"有真分支"，而分支只在开机时读一次等于没有：辅助功能面板里翻一下"减弱动态效果"，
// CSS 那侧的 media query 当场生效，canvas 这侧照旧动，画面就半新半旧。这里量的就是这一次翻转：
// 预览轮廓必须当场从"抬起 off 像素"变成"贴回原位"，并且翻回去还能恢复（单向的分支不算活）。
test('frameparity: 系统偏好中途翻转 reduceMotion，画布当场改画且可逆', () => {
  const api = live.api, env = live.env;
  eq(api.motion().subscribed, true, 'MQL 的 change 订阅没挂上 ⇒ 偏好翻转对 canvas 一侧根本不可达');
  eq(api.motion().reducedMotion, false, '桩里初值应为"允许动效"（matchMedia 默认 matches:false）');

  const board = env.getEl('board');
  const cell = api.view.metrics().cell;
  const expected = Math.min(cell * 0.35, 6);        // view.js 里那一点抬起量：off = min(cell*0.35, 6)
  const p = api.view.cutPoint(api.state.q);          // 最右一块的中心：k = q，预览块数最多，轮廓最好认

  const drawOnce = () => {
    api.restart();                                    // 清掉上一刀的预览与棋谱，剩下的 strokeRect 只有预览轮廓
    env.strokes.length = 0;
    env.fire(board, 'pointermove', { clientX: p.x, clientY: p.y });
    return env.strokes.slice();
  };

  const animated = drawOnce();
  ok(animated.length >= 2, `预览至少该画出 ${api.state.q} 块轮廓，实测 ${animated.length} 笔`);
  eq(api.state.kPreview, api.state.q, '预览没建立 ⇒ 后面比的是一帧什么都没画的空跑');

  const fired = env.setReduceMotion(true);
  ok(fired >= 1, '翻转偏好后一个 change 回调都没开火 ⇒ 订阅是假的');
  eq(api.motion().reducedMotion, true, 'view 的读数没跟上翻转');
  const still = drawOnce();
  eq(still.length, animated.length, '退化该只改位移，不该少画或多画一笔');
  const dx = animated[0].x - still[0].x;
  const dy = still[0].y - animated[0].y;              // 动效态轮廓往上抬 off，静图态贴回 originY
  ok(Math.abs(dx - expected) < 0.5, `静图态 x 该收回 ${expected.toFixed(2)}px，实测收回 ${dx.toFixed(2)}px`);
  ok(Math.abs(dy - expected) < 0.5, `静图态 y 该收回 ${expected.toFixed(2)}px，实测收回 ${dy.toFixed(2)}px`);
  ok(expected > 0, `cell=${cell} 下动效位移为 0，这条判据没有可量的东西`);

  env.setReduceMotion(false);
  eq(api.motion().reducedMotion, false, '翻回去没生效（单向分支）');
  const back = drawOnce();
  eq([back[0].x, back[0].y], [animated[0].x, animated[0].y], '翻回"允许动效"之后轮廓必须回到抬起的那一点');
  console.log(`  [reduceMotion] 动效位移 ${expected.toFixed(2)}px（cell=${cell}）：轮廓 x ${animated[0].x.toFixed(1)} → 静图 ${still[0].x.toFixed(1)} → 翻回 ${back[0].x.toFixed(1)}，change 开火 ${fired} 次`);
});

// ---------------------------------------------------------------- 7 简报 §6 阴性对照
test('frameparity: 负面控制 —— simMs += elapsed 改成 += 1 之后墙钟比值 > 3.6（尺子有牙）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'euclid-fpmut-'));
  try {
    fs.cpSync(path.join(ROOT, 'js'), path.join(tmp, 'js'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const cp = path.join(tmp, 'js/core/clock.js');
    const src = fs.readFileSync(cp, 'utf8');
    const patched = src.replace('simMs += elapsed;', 'simMs += 1;   // MUTANT：把帧计数当时间用');
    ok(patched !== src, '补丁没命中目标行：累加那一行已改写，先修补丁再谈通过');
    fs.writeFileSync(cp, patched);

    const mutant = await bootShell(path.join(tmp, 'js/main.js'));
    const mc = { ts: 1000, frames: 0 };
    const mruns = RATES.map((hz) => ladder(mutant, hz, mc));
    const mw = mruns.map((r) => r.toastOffWall);
    eq(mw.every((v) => v !== null), true, `变异组也该真的走到到期（否则是阶梯不够长），实测 ${nums(mw)}`);
    const rt = ratio(mw);
    ok(rt > 3.6, `变异后三档墙钟=${nums(mw)} 比值 ${rt.toFixed(4)} 必须 > 3.6，否则本文件的绿灯是空跑`);
    console.log(`  [负面控制] 变异组墙钟 ${nums(mw)} 比值 ${rt.toFixed(4)} ⇒ 红，尺子有牙`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await run();
