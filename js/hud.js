// 外壳的系统层：暂停 / 静音 / 全屏 / 玩法说明，加上"暂停期间输入真的进不来"这一层。
//
// 为什么单独一个文件：js/main.js 管的是这一局的读与写，而这四样是**设备级**的开关 —— 它们不该
// 需要知道 φ、帕、棋书任何东西。判据也只有一条：按下去之后机器真的停了、真的没声了、真的全屏了，
// 而不是只翻转一个 class。
//
// 暂停怎么"真"：本仓没有逐帧推进的物理（判定来自查表，点击即定），所以时间上唯一自己在走的
// 东西是会话时钟上的两个倒计时（提示条存活期、清空存档的二次确认）。暂停做三件事：
//   1. 冻结会话时钟 —— 两个倒计时不再前进（原来挂 setTimeout，切后台照样烧完，回来就过期）；
//   2. 在**捕获阶段**吃掉 pointer 事件 —— 金条不预览、按钮点不动；暂停面板与系统条除外
//      （否则没法解除暂停）。键盘快捷键不吞（见 KEEP_THROUGH），否则 P 就成了自锁；
//   3. 把 AudioContext 关掉的活儿交给 audio.js：暂停期间不再排任何音。
// 恢复不补欠账：暂停多久，模拟时间就只停多久（js/core/clock.js 的 paused 分支）。

// 暂停时要吃掉的输入事件。除了 pointer 主干，还得包括 main.js 里没有 PointerEvent 时的
// touch/mouse 回落 —— 否则在老 Safari 上"暂停"就只是盖了一层看不见的布。
const SWALLOW = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
  'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'mousedown', 'mousemove', 'mouseup'];
// 暂停时仍然可以点的东西：解除面板本身 + 右上角系统条（玩法/暂停/静音/全屏）。
const ALWAYS_ON = '.paused, .hud';
// 这些键在暂停中必须照常工作 —— 特别是 P 与 Space（同一个动作的两个键名），不然"暂停"就成了
// 只能靠鼠标出去的坑；R 也在内：暂停中看到不对劲要能直接重开，而不是先解除再重开两步。
const KEEP_THROUGH = ['p', 'P', ' ', 'r', 'R', 'm', 'M', 'f', 'F', 'h', 'H', '?', 'Escape'];

export function mountHud({ el, game, clock, audio, store, toast, onRestart = () => {} }) {
  let rafId = null;

  function requestFrame() {
    // rafId === null 意味着驱动是停着的：到下一帧之间那段空闲不是模拟时间，先立哨兵再挂帧。
    if (rafId === null) { clock.reanchor(); rafId = requestAnimationFrame(frame); }
  }
  function frame(ts) {
    rafId = null;
    clock.tick(ts);
    // 连着走的时候直接续挂，不走 requestFrame()：那是"从空闲里醒来"的入口，会把每一帧都变成哨兵帧。
    if (clock.pending > 0) rafId = requestAnimationFrame(frame);
  }

  // 1 ------------------------------------------------------------- 输入闸门
  function gate(ev) {
    if (!game.paused) return;
    if (ev.key !== undefined) {
      if (KEEP_THROUGH.includes(ev.key)) return;
    } else {
      const t = ev.target;
      if (t && t.closest && t.closest(ALWAYS_ON)) return;
    }
    ev.preventDefault();
    ev.stopPropagation();                        // 停在捕获阶段：业务 handler 看不见这次输入
  }
  for (const type of SWALLOW) window.addEventListener(type, gate, true);
  window.addEventListener('keydown', gate, true);

  // 2 ------------------------------------------------------------- 暂停
  function setPaused(v) {
    const on = !!v;
    if (on === !!game.paused) return on;
    game.paused = on;
    clock.setPaused(on);
    el.paused.hidden = !on;
    el.pause.setAttribute('aria-pressed', String(on));
    el.pause.textContent = on ? '继续' : '暂停';
    el.pause.setAttribute('aria-label', on ? '继续' : '暂停');
    return on;
  }

  // 3 ------------------------------------------------------------- 静音
  function paintMute() {
    const on = audio.muted;
    el.mute.setAttribute('aria-pressed', String(on));
    el.mute.textContent = on ? '已静音' : '静音';
    el.mute.setAttribute('aria-label', on ? '取消静音' : '静音');
  }
  function toggleMute(silent = false) {
    const next = !audio.muted;
    audio.setMuted(next);                        // 真的 suspend，不是把 gain 拧到 0
    store.setSetting('muted', next);             // 下一次重载还是这个状态
    paintMute();
    if (!silent) toast(next ? '已静音：切金与结算都不出声（M 解除）' : '声音开了');
    if (!next) audio.unlock();
    return next;
  }

  // 4 ------------------------------------------------------------- 全屏
  // 三套 API 一律**特性探测**，不做 UA 判断：老 iOS Safari 只有 webkit*，老 Edge 只有 ms*。
  // 只认 document.fullscreenElement 的话，在那些浏览器上「退出全屏」会变成「再进一次」。
  // （并线时另一侧有一份带前缀的实现，绑的是不存在的 #btn-fullscreen；前缀这份能力并到了这里。）
  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;
  const fsRequest = (node) => node.requestFullscreen || node.webkitRequestFullscreen
    || node.msRequestFullscreen || null;
  const fsExit = () => document.exitFullscreen || document.webkitExitFullscreen
    || document.msExitFullscreen || null;

  function toggleFullscreen() {
    if (fsElement()) {
      const exit = fsExit();
      if (!exit) return false;
      const out = exit.call(document);
      if (out && out.catch) out.catch((err) => toast('退出全屏失败：' + err.message, true));
      return false;
    }
    const node = document.documentElement;
    const request = fsRequest(node);
    if (!request) {
      // 不支持也要说清楚为什么：只把按钮变灰而不解释，玩家会以为这活根本没做完。
      el.fullscreen.disabled = true;
      el.fullscreen.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
      toast('这台设备不支持网页全屏', true);
      return false;
    }
    let go = null;
    try {
      // navigationUI 只对标准 API 有效，带前缀的那两个不吃这个参数。
      go = node.requestFullscreen
        ? node.requestFullscreen.call(node, { navigationUI: 'hide' })
        : request.call(node);
    } catch (err) {
      toast('全屏被拒绝：' + err.message, true);
      return false;
    }
    if (go && go.catch) go.catch((err) => toast('全屏被拒绝：' + err.message, true));
    return true;
  }
  function syncFullscreen() {
    const on = !!fsElement();
    el.fullscreen.setAttribute('aria-pressed', String(on));
    el.fullscreen.textContent = on ? '退出全屏' : '全屏';
  }
  document.addEventListener('fullscreenchange', syncFullscreen);
  document.addEventListener('webkitfullscreenchange', syncFullscreen);
  document.addEventListener('MSFullscreenChange', syncFullscreen);

  // 5 ------------------------------------------------------------- 玩法说明
  function showTutorial(v) {
    el.tutorial.hidden = !v;
    el.help.setAttribute('aria-pressed', String(!el.tutorial.hidden));
  }
  function toggleTutorial() { showTutorial(el.tutorial.hidden); }
  function closeTutorial() {
    if (el.tutnever.checked) store.setSetting('showTutorial', false);
    showTutorial(false);
  }
  function wantTutorial() {
    if (store.settings.showTutorial === false) return false;
    const t = store.totals();
    // 只在这台设备真的什么都没打过时自动展开；打过一次之后等用户自己按 H。
    return t.plays === 0 && t.cleared === 0;
  }

  el.pause.addEventListener('click', () => setPaused(!game.paused));
  el.resume.addEventListener('click', () => setPaused(false));
  el.mute.addEventListener('click', () => toggleMute());
  el.fullscreen.addEventListener('click', toggleFullscreen);
  el.help.addEventListener('click', toggleTutorial);
  el.tutclose.addEventListener('click', closeTutorial);
  el.tutnever.addEventListener('change', () => store.setSetting('showTutorial', !el.tutnever.checked));

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;   // 不打断正在输入的东西
    const k = ev.key;
    // 焦点在按钮上时，空格是浏览器的原生"激活"键：让给它，全局这支不再动 —— 否则一次按下
    // 先点中那个按钮、再翻一次暂停，看起来就像按了没反应。字母键不受这条影响。
    if (k === ' ' && t && t.tagName === 'BUTTON') return;
    if (k === 'h' || k === 'H' || k === '?') { toggleTutorial(); ev.preventDefault(); }
    else if (k === 'm' || k === 'M') { toggleMute(); ev.preventDefault(); }
    else if (k === 'f' || k === 'F') { toggleFullscreen(); ev.preventDefault(); }
    else if (k === 'p' || k === 'P' || k === ' ') { setPaused(!game.paused); ev.preventDefault(); }
    else if (k === 'r' || k === 'R') { onRestart(); ev.preventDefault(); }
    else if (k === 'Escape' && !el.tutorial.hidden) { closeTutorial(); ev.preventDefault(); }
  });

  // 真实手势里才解锁音频：Chrome/Safari 只承认用户手势链上的 AudioContext。
  const unlockOnce = () => { if (!audio.muted) audio.unlock(); };
  window.addEventListener('pointerdown', unlockOnce, { once: true });
  window.addEventListener('keydown', unlockOnce, { once: true });

  paintMute();
  syncFullscreen();
  showTutorial(wantTutorial());
  requestFrame();

  return {
    clock,
    audio,
    requestFrame,
    setPaused,
    toggleMute,
    toggleFullscreen,
    toggleTutorial,
    showTutorial,
    get paused() { return !!game.paused; },
    get muted() { return audio.muted; },
    status() {
      return {
        paused: !!game.paused,
        muted: audio.muted,
        audio: audio.state,
        fullscreen: !!document.fullscreenElement,
        tutorial: !el.tutorial.hidden,
        simMs: Math.round(clock.simMs),
        pending: clock.pending,
      };
    },
  };
}
