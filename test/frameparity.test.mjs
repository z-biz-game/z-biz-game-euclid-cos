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
  const ctxHard = {
    measureText: () => ({ width: 8 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createPattern: () => ({ setTransform() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
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

  const globals = {
    document: documentStub,
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    matchMedia: (q) => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
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

  return { getEl, frames, raf, fire, documentStub, localStorage };
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

// ---------------------------------------------------------------- 4 §6 阴性对照
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
