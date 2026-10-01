// test/clock.test.mjs — 会话时钟：三档帧率、暂停、后台节流，最后是一个负面控制。
//
// 这是 BRIEF_COS §3 要求的那张"帧率三档对照表"。本仓没有逐帧物理，唯一真的按时间自己走的
// 东西是外壳里的两个倒计时（提示条 2600ms、清空存档 4000ms），所以对照的对象就是倒计时到达
// 的**墙钟时刻**：同一颗 LCG 种子、同一个沙箱起点(1000ms)、同一段墙钟时长，分别在 30/60/120Hz
// 下推进，量"2600ms 的提示条在第几毫秒的墙上时间消失"。正确实现下三档之比 ≈ 1；把累加那一行
// 改成 `simMs += 1`（也就是"按帧计数当时间用"）之后，三档之比应当 > 3.6 —— §6 的负面控制，
// 证明这组断言不是摆设，它确实能抓住帧率依赖。
//
// 时钟源用注入的时间戳（浏览器里是 rAF 的 ts），所以这里不需要任何真等待。
//   node test/clock.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';
import fs from 'node:fs';

const CLOCK_URL = new URL('../js/core/clock.js', import.meta.url);
const RATES = [30, 60, 120];
const WALL_MS = 90_000;      // 沙箱里跑 90 秒墙钟，够 2600ms 的倒计时在最慢档位也能到期
const TOAST_MS = 2600;       // 与 js/main.js 的 TOAST_MS 同值
const SEED = 20261001;

// 同一颗种子喂给三档，帧间抖动才是可控的：不同档位之间的差异只能来自"时间怎么累加"。
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 读真源、可选打补丁，然后以 data: URL 重新求值一份 —— 负面控制要的是一份改过一行的时钟，
// 而不是在测试里手写一个"像时钟的东西"。
async function loadClock(patch) {
  let src = fs.readFileSync(CLOCK_URL, 'utf8');
  if (patch) {
    const next = patch(src);
    ok(next !== src, '负面控制的补丁没有命中目标行：目标行已改写，先修补丁再谈通过');
    src = next;
  }
  return await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// 一档 = 一个帧率。返回 sim 总时长、倒计时开火时的 sim 时刻、以及那一刻的墙钟时刻。
function ladder(mod, rateHz) {
  const clock = mod.createClock();
  const rnd = lcg(SEED);
  const dt = 1000 / rateHz;
  const t0 = 1000;                       // 沙箱时钟从 1000ms 起：0 只做"第一帧是哨兵"
  let wall = 0;
  let firedSim = null;
  let firedWall = null;
  clock.after(TOAST_MS, () => { firedSim = clock.simMs; firedWall = wall; });
  for (let ts = t0; ts - t0 < WALL_MS; ts += dt) {
    const jitter = (rnd() - 0.5) * dt * 0.5;
    wall = ts + jitter - t0;
    clock.tick(ts + jitter);
  }
  return { rateHz, simMs: clock.simMs, firedSim, firedWall };
}

const ratio = (xs) => Math.max(...xs) / Math.min(...xs);
const nums = (xs) => xs.map((x) => x.toFixed(1)).join(' / ');

test('clock: 30/60/120Hz 三档跑同一段墙钟，sim 时间一致（比值 < 1.001）', async () => {
  const mod = await loadClock();
  const runs = RATES.map((r) => ladder(mod, r));
  const sims = runs.map((r) => r.simMs);
  const rt = ratio(sims);
  ok(rt < 1.001, `三档 simMs=${nums(sims)} 比值 ${rt.toFixed(5)} 应 < 1.001`);
  ok(Math.max(...sims) - Math.min(...sims) < 40,
     `三档 simMs 之差 ${(Math.max(...sims) - Math.min(...sims)).toFixed(2)}ms 应 < 40ms（最慢档的一帧）`);
  for (const r of runs) {
    ok(Math.abs(r.simMs - WALL_MS) < 40, `${r.rateHz}Hz 档 simMs=${r.simMs.toFixed(1)} 应贴着 ${WALL_MS}（±一帧抖动）`);
  }
});

test('clock: 2600ms 提示条在三档帧率下同一墙钟时刻消失（比值 < 1.02）', async () => {
  const mod = await loadClock();
  const runs = RATES.map((r) => ladder(mod, r));
  const walls = runs.map((r) => r.firedWall);
  const sims = runs.map((r) => r.firedSim);
  eq(walls.every((w) => w !== null), true, '三档都得让倒计时真的开火');
  const rt = ratio(walls);
  ok(rt < 1.02, `开火墙钟时刻=${nums(walls)} 比值 ${rt.toFixed(5)} 应 < 1.02`);
  for (const s of sims) ok(Math.abs(s - TOAST_MS) < 40, `开火 sim=${s.toFixed(1)} 应贴着 ${TOAST_MS}`);
});

test('clock: 暂停是真的停 —— 暂停里 589 帧不加一毫秒，解冻后也不补暂停的账', async () => {
  const mod = await loadClock();
  const clock = mod.createClock();
  clock.tick(1000);
  clock.tick(1100);
  eq(clock.simMs, 100, '哨兵帧之后才开始计时');
  eq(clock.setPaused(true), true);
  let fired = 0;
  clock.after(50, () => { fired += 1; });
  for (let ts = 1200; ts <= 60000; ts += 100) clock.tick(ts);
  eq(clock.simMs, 100, '暂停期间的每一帧都只跟住时标');
  eq(clock.pending, 1, '暂停不该吃掉定时器');
  eq(fired, 0, '暂停里的倒计时不能偷偷到期');
  clock.setPaused(false);
  clock.tick(60100);
  eq(clock.simMs, 200, '解冻后第一帧只补这 100ms，不补暂停那 58.9 秒');
  eq(fired, 1, '解冻后倒计时继续，越过 150ms 就开火');
});

test('clock: 后台节流 —— 单帧 5000ms 只补 MAX_STEP_MS，1.2s 的倒计时 20 秒后仍在', async () => {
  const mod = await loadClock();
  const clock = mod.createClock();
  eq(mod.MAX_STEP_MS, 250);
  clock.tick(1000);
  eq(clock.tick(6000), 250, '一次 5s 的间隔最多折算 250ms');
  let fired = 0;
  clock.after(1200, () => { fired += 1; });
  clock.tick(11000);
  clock.tick(16000);
  eq(clock.simMs, 750, '三帧 15s 墙钟 → 750ms 模拟时间');
  eq(fired, 0, '墙上过了 15 秒，1.2 秒的倒计时不该到期');
  clock.tick(21000);
  clock.tick(26000);
  eq([clock.simMs, fired], [1250, 0], '20 秒墙钟还不够它到期');
  clock.tick(31000);
  eq([clock.simMs, fired], [1500, 1], '继续逐帧补偿，倒计时最终照常开火');
});

test('clock: 时标倒退不加时间（换时钟源 / 调试器改钟）', async () => {
  const mod = await loadClock();
  const clock = mod.createClock();
  clock.tick(5000);
  clock.tick(5100);
  eq(clock.simMs, 100, '这一帧走 100ms，没到 MAX_STEP_MS');
  clock.tick(1000);
  eq(clock.simMs, 100, '时标倒退必须当 0，且不许欠账');
  clock.tick(1100);
  eq(clock.simMs, 200, '倒退之后照样能继续走');
});

test('clock: after/cancel/has —— 取消的倒计时不开火，重挂不留双定时器', async () => {
  const mod = await loadClock();
  const clock = mod.createClock();
  const seen = [];
  clock.tick(1000);
  clock.tick(1060);
  const slow = clock.after(100, () => seen.push('slow'));
  const fast = clock.after(50, () => seen.push('fast'));
  eq(clock.pending, 2);
  ok(clock.has(slow) && clock.has(fast));
  clock.cancel(slow);
  eq(clock.has(slow), false);
  eq(clock.pending, 1, 'cancel 必须真的把槽位还回来');
  clock.tick(1070);
  eq(seen, [], '这一帧只走了 10ms，两个都还没到');
  clock.tick(1120);
  eq(seen, ['fast'], '只剩被留下的那个开火');
  eq(clock.pending, 0);
  const again = clock.after(200, () => seen.push('again'));
  clock.cancel(again);
  const third = clock.after(200, () => seen.push('third'));
  clock.tick(1140);
  eq([seen.length, clock.pending], [1, 1], '重挂之后只剩一个定时器在跑，也没有第二个开火');
  clock.cancel(third);
  eq(clock.pending, 0);
});

test('clock: 负面控制 —— simMs += elapsed 改成 += 1 后三档比值 > 3.6', async () => {
  const mod = await loadClock((src) => src.replace('simMs += elapsed;', 'simMs += 1;'));
  const runs = RATES.map((r) => ladder(mod, r));
  const walls = runs.map((r) => r.firedWall);
  const sims = runs.map((r) => r.simMs);
  const rw = ratio(walls);
  const rs = ratio(sims);
  ok(rw > 3.6, `开火墙钟时刻=${nums(walls)} 比值 ${rw.toFixed(3)} 应 > 3.6（否则断言抓不到帧率依赖）`);
  ok(rs > 3.6, `simMs=${nums(sims)} 比值 ${rs.toFixed(3)} 应 > 3.6`);
  const frames = RATES.map((r) => Math.round(WALL_MS * r / 1000));
  ok(sims.every((s, i) => Math.abs(s - frames[i]) <= 2),
     `突变体 simMs=${nums(sims)} 应当等于各自的帧数 ${nums(frames)}（时间被当成了帧计数）`);
});

test('clock: 全仓只有会话时钟在推进时间 —— main/hud 里不许有 setTimeout/setInterval', async () => {
  for (const rel of ['../js/main.js', '../js/hud.js']) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    eq(src.match(/(setTimeout|setInterval)\s*\(/g) || [], [], `${rel} 里还留着原生定时器`);
  }
  const main = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const hud = fs.readFileSync(new URL('../js/hud.js', import.meta.url), 'utf8');
  eq((main.match(/clock\.after\(/g) || []).length, 2, '两个倒计时（提示条 + 清空确认）都该走会话时钟');
  ok(hud.includes('clock.tick(ts)'), 'hud 是唯一的逐帧驱动者');
  eq((hud.match(/requestAnimationFrame/g) || []).length, 1, '只许一处 rAF，帧循环不能到处都是');
});

run();
