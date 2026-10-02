// test/hud.test.mjs — 设备级四闸（暂停 / 静音 / 全屏 / 玩法说明）+ 全局快捷键，在 node 里量。
//
// 为什么这一份值得存在：判据是"按下去之后机器真的停了、真的没声了"，而字符串命中证明不了任何
// 一件事。js/hud.js 不 import 任何仓内模块、js/core/audio.js 只在真实手势链里才碰 AudioContext，
// 所以把它们挂在一个最小 DOM 桩上，就能真的派发 keydown/pointerdown、真的数振荡器节点、真的读
// 会话时钟的累加值 —— 全部不需要浏览器（浏览器那条线 tools/playtest.mjs 目前没有一支覆盖系统条）。
//
// 四条最容易悄悄退化的行为，逐条钉住：
//   1. 暂停期间 simMs 一格不动，恢复后不补欠账；暂停吃掉真实 pointer/数字键，但 P/Space/R/M/F/
//      H/Esc 不吞（吞了 P 就成了只能靠鼠标出去的坑）。
//   2. 静音：AudioContext 真被 suspend()，且静音期间一个 createOscillator 都不许发生
//      （只把 gain 拧到 0 是假静音：照样耗电、照样占设备，解除时把攒下的排程一次放出来）。
//   3. Space 落在 <button> 上时让位给浏览器的原生激活，否则"暂停"键同时点了按钮 = 双触发。
//   4. 帧驱动只在有活时挂着：requestFrame() 是"从空闲里醒来"的唯一入口（js/core/clock.js 的
//      reanchor），所以本测试每推进一帧都要先 requestFrame()，和生产代码里 toast/倒计时的做法一致。
//   node test/hud.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';
import { mountHud } from '../js/hud.js';
import { createClock } from '../js/core/clock.js';
import { createAudio } from '../js/core/audio.js';

// ---------------------------------------------------------------- DOM 桩
function makeDom() {
  const listeners = new Map();          // target -> type -> [fn]
  const add = (target) => (type, fn) => {
    const m = listeners.get(target) || new Map();
    m.set(type, (m.get(type) || []).concat(fn));
    listeners.set(target, m);
  };
  const fire = (target, type, ev = {}) => {
    const ev2 = Object.assign({ type, defaultPrevented: false, _stopped: false }, ev);
    ev2.preventDefault = () => { ev2.defaultPrevented = true; };
    ev2.stopPropagation = () => { ev2._stopped = true; };
    for (const fn of (listeners.get(target) || new Map()).get(type) || []) fn(ev2);
    return ev2;
  };

  const raf = [];
  const audio = { oscillators: 0, suspend: 0, resume: 0 };
  function AudioContextStub() {
    const c = this;
    c.state = 'suspended';
    c.currentTime = 0;
    c.destination = {};
    c.sampleRate = 48000;
    const param = () => ({
      value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {},
      setTargetAtTime() {}, cancelScheduledValues() {},
    });
    c.createOscillator = () => { audio.oscillators++; return { type: 'sine', frequency: param(), connect() {}, disconnect() {}, start() {}, stop() {} }; };
    c.createGain = () => ({ gain: param(), connect() {}, disconnect() {} });
    c.resume = () => { c.state = 'running'; audio.resume++; return Promise.resolve(); };
    c.suspend = () => { c.state = 'suspended'; audio.suspend++; return Promise.resolve(); };
    c.close = () => Promise.resolve();
  }

  const el = {};
  // classes 对上 index.html 的真实挂载：暂停面板在 .paused 里，四支系统键在 .hud 这条 bar 里。
  const BAR = ['pause', 'mute', 'fullscreen', 'help'];
  for (const id of ['paused', 'pause', 'resume', 'mute', 'fullscreen', 'help', 'tutorial', 'tutclose', 'tutnever']) {
    const node = {
      id, tagName: id === 'tutnever' ? 'INPUT' : 'BUTTON', hidden: false, checked: false,
      textContent: '', attrs: {},
      classes: new Set(id === 'paused' ? ['paused'] : (BAR.includes(id) ? ['hud'] : [])),
    };
    node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
    node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
    node.addEventListener = add(node);
    // 真实的 closest 接受复合选择器（'.paused, .hud'）：按逗号拆开逐个对 class，不然闸门那支
    // "永远放行"的分支在桩里永远走不到，测试就只是在测桩。
    node.closest = (sel) => {
      const hit = String(sel).split(',').some((s) => {
        const c = s.trim().replace(/^\./, '');
        return c ? node.classes.has(c) : false;
      });
      return hit ? node : null;
    };
    el[id] = node;
  }
  // 金条上一个与闸门两类选择器都不相干的元素：暂停时的 pointerdown 必须落在这里被吞掉
  const board = { id: 'board', tagName: 'CANVAS', closest: () => null };

  const documentStub = { fullscreenElement: null, documentElement: {}, addEventListener: add('document') };
  globalThis.window = { addEventListener: add('window'), removeEventListener: () => {}, AudioContext: AudioContextStub };
  globalThis.document = documentStub;
  globalThis.requestAnimationFrame = (cb) => { raf.push(cb); return raf.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.AudioContext = AudioContextStub;
  return {
    el, board, audio, raf, documentStub, fire, add,
    frame: (ts) => { const q = raf.splice(0, raf.length); for (const cb of q) cb(ts); return q.length; },
  };
}

function mount(opts = {}) {
  const d = makeDom();
  const game = { paused: false };
  const clock = createClock();
  const audio = createAudio({ muted: !!opts.muted });
  const store = {
    // settings 必须在 mountHud 之前就位：教学是否自动展开是在挂载时读 wantTutorial() 定的，
    // 挂载完再写就已经错过那一次判定了。
    settings: Object.assign({}, opts.settings),
    setSetting(k, v) { this.settings[k] = v; return v; },
    totals: () => ({ plays: opts.plays === undefined ? 1 : opts.plays, cleared: opts.cleared === undefined ? 1 : opts.cleared }),
  };
  const toasts = [];
  let restarts = 0;
  const hud = mountHud({
    el: d.el, game, clock, audio, store,
    toast: (m) => toasts.push(m),
    onRestart: () => { restarts++; },
  });
  // 生产代码只在有活时挂帧（toast / 倒计时），所以推一帧 = 先 requestFrame 再 drain
  const advance = (ts) => { hud.requestFrame(); return d.frame(ts); };
  return { d, el: d.el, game, clock, audio, store, hud, toasts, advance, restarts: () => restarts };
}

const key = (d, k, target) => d.fire('window', 'keydown', { key: k, target });

// ---------------------------------------------------------------- 1 暂停
test('hud: Space 与 P 都能暂停；暂停期间 simMs 一格不动、恢复不补欠账', () => {
  const m = mount();
  const hold = m.clock.after(60000, () => {});   // 有活才挂帧：生产里是 toast / 倒计时
  m.d.frame(1000);
  eq(m.clock.simMs, 0, '哨兵帧只记时');
  m.d.frame(1100);
  eq(m.clock.simMs, 100, '跟着走了 100ms');
  key(m.d, ' ');                              // Space 暂停
  eq([m.game.paused, m.clock.paused], [true, true], 'Space 必须真的把时钟挂起来');
  m.d.frame(1200); m.d.frame(2000); m.d.frame(3400);
  eq(m.clock.simMs, 100, `暂停期间走了 2300ms 墙钟，simMs 必须停在 100（实测 ${m.clock.simMs}）`);
  eq(m.el.paused.hidden, false, '暂停面板必须显形（hidden=false 才是看得见）');
  eq(m.el.pause.textContent, '继续');
  key(m.d, 'P');                              // 大写 P 解除
  eq(m.game.paused, false);
  m.d.frame(3500);
  eq(m.clock.simMs, 200, '恢复后只补这一帧的 100ms，不欠暂停期间那 2300ms');
  m.clock.cancel(hold);
  eq(m.clock.pending, 0, '待办清空之后驱动该自己停下来');
});

test('hud: 暂停吃掉真实 pointer 与数字键，但 P/Space/R/M/F/H/?/Esc 一支都不吞', () => {
  const m = mount();
  key(m.d, 'p');
  eq(m.game.paused, true);
  const swallowed = m.d.fire('window', 'pointerdown', { target: m.d.board });
  ok(swallowed.defaultPrevented && swallowed._stopped, '暂停中的 pointerdown 必须停在捕获阶段');
  const cut = m.d.fire('window', 'keydown', { key: '1', target: m.d.board });
  ok(cut._stopped, '暂停中的数字键同样被吞');
  const seen = [];
  for (const k of ['p', 'P', ' ', 'r', 'R', 'm', 'M', 'f', 'F', 'h', 'H', '?', 'Escape']) {
    m.hud.setPaused(true);                    // 上一条快捷键可能已经翻了状态：按回暂停再测闸门
    const ev = m.d.fire('window', 'keydown', { key: k, target: m.d.board });
    ok(!ev._stopped, `KEEP_THROUGH 里的 ${JSON.stringify(k)} 不该被吞（吞了 P 就自锁）`);
    if (!ev.defaultPrevented) seen.push(k);
  }
  ok(m.restarts() >= 1, `暂停中按过 R，onRestart 必须被叫到（实测 ${m.restarts()} 次）`);
  eq(seen, [], `不被吞还不够，每一支都要真的办成事（没 preventDefault 的：${JSON.stringify(seen)}）`);
  ok(m.toasts.some((t) => /静音/.test(t)), '暂停中按 M 的 toast 也照常出');
});

test('hud: 暂停解除之后同一批输入照常落地', () => {
  const m = mount();
  key(m.d, 'p');
  key(m.d, 'r');                              // 暂停中重开：闸门照旧关着
  eq(m.restarts(), 1);
  ok(m.d.fire('window', 'pointerdown', { target: m.d.board })._stopped, 'R 之后还在暂停里，输入照旧被吞');
  key(m.d, ' ');
  ok(!m.d.fire('window', 'pointerdown', { target: m.d.board })._stopped, '解除之后 pointerdown 必须放行');
  // 贴在 .paused / .hud 上的东西永远放行，否则没法点"继续"
  m.hud.setPaused(true);
  ok(!m.d.fire('window', 'pointerdown', { target: m.d.el.paused })._stopped, '暂停面板自己不能被吞');
  ok(!m.d.fire('window', 'pointerdown', { target: { closest: () => ({}) } })._stopped, '系统条同理');
});

test('hud: Space 落在按钮上让位给原生激活，不许双触发', () => {
  const m = mount();
  key(m.d, ' ', { tagName: 'BUTTON' });
  eq(m.game.paused, false, '焦点在按钮上时空格该只点按钮，不再翻一次暂停');
  key(m.d, ' ');
  eq(m.game.paused, true, '焦点不在按钮上时空格照常暂停');
  key(m.d, ' ', { tagName: 'INPUT' });
  eq(m.game.paused, true, '正在输入时空格一个字都不该动');
});

// ---------------------------------------------------------------- 2 静音
test('hud: 静音真停 AudioContext，且静音期间零振荡器', () => {
  const m = mount();
  m.audio.unlock();                            // 真实手势链上的解锁
  eq(m.audio.state, 'running');
  ok(m.audio.cut() === true, '未静音时切金该出声');
  eq([m.d.audio.oscillators, m.d.audio.suspend], [1, 0]);
  key(m.d, 'm');                               // 静音
  eq([m.hud.muted, m.audio.state, m.d.audio.suspend], [true, 'suspended', 1],
    `静音要同时改状态并 suspend 设备（实测 muted=${m.hud.muted} state=${m.audio.state} suspend=${m.d.audio.suspend}）`);
  const before = m.d.audio.oscillators;
  ok(m.audio.play('cut') === false, '静音期间 play() 必须返回 false');
  key(m.d, '1');
  eq(m.d.audio.oscillators, before, `静音期间一个振荡器都不许新建（实测 ${before} → ${m.d.audio.oscillators}：只把 gain 拧到 0 是假静音）`);
  eq(m.store.settings.muted, true, '静音态要写进存档，重载还是这个状态');
  key(m.d, 'M');                               // 解除
  eq([m.hud.muted, m.audio.state], [false, 'running'], '解除静音要把设备重新要回来');
  ok(m.audio.play('win') === true, '解除之后要能再出声');
  eq(m.d.audio.oscillators, before + 1, '解除后那一刀必须真的排到一个振荡器');
});

test('hud: 一路静音开局也不炸（从未建过 context 的会话）', () => {
  const m = mount({ muted: true });
  eq(m.audio.state, 'none', '静音开局不该在模块求值期就 new AudioContext');
  eq(m.el.mute.textContent, '已静音', '按钮状态要在挂载时就对上');
  ok(m.audio.play('cut') === false);
  eq(m.d.audio.oscillators, 0, '静音开局期间零振荡器');
  key(m.d, 'm');                               // 解除静音
  eq([m.hud.muted, m.audio.state], [false, 'running'], '解除之后才第一次建 context');
  ok(m.audio.play('cut') === true);
  eq(m.d.audio.oscillators, 1);
});

// ---------------------------------------------------------------- 3 全屏 / 玩法说明
test('hud: 全屏在没有 requestFullscreen 的设备上如实说"不支持"，不抛', () => {
  const m = mount();
  eq(m.hud.toggleFullscreen(), false, '桩里没有 requestFullscreen：必须走"不支持"那支');
  ok(m.toasts.some((t) => /不支持/.test(t)), `要 toast 出原因（实测 ${JSON.stringify(m.toasts)}）`);
  eq(m.el.fullscreen.attrs['aria-pressed'], 'false');
  eq(m.el.fullscreen.textContent, '全屏');
});

test('hud: H/? 开关玩法说明，勾了"不再自动显示"才落盘', () => {
  const m = mount({ plays: 0, cleared: 0 });
  eq(m.el.tutorial.hidden, false, '全新设备（plays/cleared 都是 0）自动展开教学');
  key(m.d, 'h');
  eq(m.el.tutorial.hidden, true, 'H 关掉');
  ok(!('showTutorial' in m.store.settings), '只是关掉这一次，不该写存档');
  key(m.d, '?');
  eq(m.el.tutorial.hidden, false, '? 与 H 同义');
  eq(m.el.help.attrs['aria-pressed'], 'true');
  m.d.fire(m.d.el.tutclose, 'click', {});       // 没勾选就"知道了"：只关不写
  ok(!('showTutorial' in m.store.settings), '未勾选不许污染存档');
  m.d.el.tutnever.checked = true;
  m.d.fire(m.d.el.tutclose, 'click', {});
  eq(m.store.settings.showTutorial, false, '勾了"不再自动显示"才落盘');
  // 第二次挂载：带着这条设置，教学就该不再自己弹出来
  const again = mount({ plays: 0, cleared: 0, settings: { showTutorial: false } });
  eq(again.el.tutorial.hidden, true, 'showTutorial=false 的设备不再自动弹教学');
});

test('hud: status() 报的是真机器状态，不是按钮文案', () => {
  const m = mount();
  const hold = m.clock.after(60000, () => {});
  m.d.frame(1000); m.d.frame(1100);
  const s0 = m.hud.status();
  key(m.d, 'p');
  m.d.frame(1200); m.d.frame(2100);
  const s1 = m.hud.status();
  eq([s0.paused, s1.paused], [false, true]);
  eq([s0.simMs, s1.simMs], [100, 100], 'status 里的 simMs 在暂停期间不该动');
  m.audio.unlock();                                 // 真实手势才会建 context：先把它要回来
  eq(m.hud.status().audio, 'running');
  key(m.d, 'm');
  eq(m.hud.status().audio, 'suspended', 'status 要能看出设备真的被放了');
  eq(m.hud.status().tutorial, false, '打过这台的设备不该自弹教学');
});

run();
