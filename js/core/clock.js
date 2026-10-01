// 固定步长的会话时钟：把"过了多久"与"渲染了几帧"彻底分开。
//
// 为什么这一仓需要它：本仓没有任何逐帧推进的物理（一局的判定来自查表，点击即定），唯一真的
// 需要"按时间自己走"的东西是外壳里的两个倒计时 —— 提示条的存活期与"清空存档"的二次确认窗口。
// 它们原来挂在 setTimeout 上：切到后台标签页照样烧完，回来时用户看到的是一条早就该消失的提示，
// 或者一个悄悄过期的确认按钮。把这两个倒计时交给一个可暂停、可冻结的时钟，才是真的把它们做对了。
//
// 三条不变量，test/clock.test.mjs 逐条量：
//   1. **只与墙钟经过量有关**：同一个墙钟时长里，推进的 sim 时间只取决于每帧的 `elapsed`，与
//      调用次数无关（30/60/120 Hz 三档跑出的 sim 时间之比 < 1.001，差在最慢档的一帧以内）。
//   2. **后台回来不追帧**：单帧 `elapsed` 上限 `MAX_STEP_MS`。浏览器把标签页节流到 1 Hz 之后，
//      一次 5000ms 的间隔不许变成 5000ms 的模拟时间 —— 那是"回来就过期"的另一种形态。
//   3. **暂停是真的停**：`paused` 期间 elapsed 一律不计，恢复后从当前时间戳继续，不欠账。
export const MAX_STEP_MS = 250;      // 单帧最多补这么多模拟时间（后台节流保护）

export function createClock() {
  let simMs = 0;          // 唯一可信的"游戏内时间"：只在这里累加
  let lastTs = null;      // null 是哨兵：第一帧只记时标，不推进（0 → 1000ms 不是过了一秒）
  let paused = false;
  const timers = [];

  function prune(now) {
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].id !== undefined) continue;
      if (now >= timers[i].at) {
        const { fn } = timers[i];
        timers.splice(i, 1);
        fn();
      }
    }
  }

  return {
    get simMs() { return simMs; },
    get paused() { return paused; },
    get pending() { return timers.length; },

    // ts 是 rAF（或测试）给的时间戳。返回这一帧推进了多少模拟时间。
    tick(ts) {
      const now = Number(ts);
      if (!Number.isFinite(now)) return 0;
      if (lastTs === null) {
        lastTs = now;
        prune(simMs);
        return 0;
      }
      if (paused) {
        lastTs = now;          // 暂停期间只跟住时标：恢复后不会把暂停的时长一次补上
        return 0;
      }
      let elapsed = now - lastTs;
      if (elapsed < 0) elapsed = 0;           // 时标倒退（换时钟源、调试器改钟）不欠账
      if (elapsed > MAX_STEP_MS) elapsed = MAX_STEP_MS;
      lastTs = now;
      simMs += elapsed;
      prune(simMs);
      return elapsed;
    },

    // 从现在起 `ms` 模拟毫秒之后触发；暂停与后台节流都不会让它提前到期（也不会让它悄悄到期）。
    after(ms, fn) {
      const timer = { at: simMs + Math.max(0, Number(ms) || 0), fn, id: undefined };
      timers.push(timer);
      return timer;
    },

    cancel(timer) {
      const i = timers.indexOf(timer);
      if (i >= 0) timers.splice(i, 1);
    },

    has(timer) { return timers.includes(timer); },

    setPaused(v) {
      paused = !!v;
      return paused;
    },

    reset() {
      simMs = 0;
      lastTs = null;
      timers.length = 0;
      paused = false;
    },
  };
}
