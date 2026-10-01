// 声音：三个短音（切金、铺满、被拒），全部由 WebAudio 现场合成，仓里一个音频文件都没有。
//
// 三条硬规矩，都是踩过坑的：
//   1. **AudioContext 只在真实手势里建**。在模块顶层 new AudioContext() 会被 Chrome 的自动播放
//      策略拦下并打一条 warning，而本仓的验收里"console 干净"是硬判据（tools/verify.sh grep [warning]）。
//      所以 create-or-resume 只发生在 pointerdown/keydown 的处理链里。
//   2. **静音是真的静**：静音时一个振荡器都不创建，并且把 context suspend 掉 —— 只把 gain 拧到 0
//      仍然在耗电、仍然占用音频设备，而且下一次解除静音时会把攒下的排程一起放出来。
//   3. **时长用模拟时钟给**，但排程用 context 自己的时钟（audioCtx.currentTime）：两者不混用，
//      否则一次后台节流就会把音符排到过去，WebAudio 会直接丢掉它们。
const TONES = {
  cut: { freq: 660, dur: 0.075, type: 'triangle', gain: 0.16 },
  win: { freq: 880, dur: 0.24, type: 'sine', gain: 0.2 },
  loss: { freq: 180, dur: 0.3, type: 'sawtooth', gain: 0.12 },
  nope: { freq: 120, dur: 0.09, type: 'square', gain: 0.08 },
};

export function createAudio({ muted = false } = {}) {
  let ctx = null;
  let master = null;
  let isMuted = !!muted;
  let blocked = false;      // 建不起来（无 WebAudio / 被策略拒绝）—— 说一次，不反复试

  function ensure() {
    if (ctx || blocked) return ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { blocked = true; return null; }
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
    } catch {
      blocked = true;
      ctx = null;
    }
    return ctx;
  }

  function play(name = 'cut') {
    if (isMuted) return false;                 // 静音：连振荡器都不创建
    const c = ensure();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const spec = TONES[name] || TONES.cut;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, t0);
    // 一个极短的 attack + 指数 release：没有它，75ms 的方波就是一声"咔"，听着像报错。
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(spec.gain, t0 + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
    osc.connect(env);
    env.connect(master);
    osc.start(t0);
    osc.stop(t0 + spec.dur + 0.02);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
    return true;
  }

  return {
    get muted() { return isMuted; },
    get blocked() { return blocked; },
    get state() { return ctx ? ctx.state : 'none'; },
    play,
    cut: () => play('cut'),
    win: () => play('win'),
    loss: () => play('loss'),
    nope: () => play('nope'),
    setMuted(v) {
      isMuted = !!v;
      if (ctx) {
        // 静音就把设备还出去；解除时才重新要。从没建过 context 的会话（一路静音）什么都不用做。
        const p = isMuted ? ctx.suspend() : ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      return isMuted;
    },
    // 真实手势里调用一次：让 iOS/Chrome 认可这个会话可以出声。不做任何排程。
    unlock() {
      const c = ensure();
      if (c && c.state === 'suspended' && !isMuted) c.resume().catch(() => {});
      return !!c;
    },
    close() {
      if (!ctx) return false;
      const c = ctx;
      ctx = null;
      master = null;
      c.close().catch(() => {});
      return true;
    },
  };
}
