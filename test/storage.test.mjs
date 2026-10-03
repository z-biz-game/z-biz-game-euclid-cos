// test/storage.test.mjs — the save file, without a browser.
//
// js/core/storage.js is the only core module allowed to mention `window`, so this suite is the one
// that has to supply a fake one. Every test imports a FRESH instance (`?n=` cache-buster) because
// the module keeps an in-memory cache; a shared instance would let one test's save leak into the
// next and make every assertion here a lie about ordering.
//
// What is being held: ONE key, plain JSON, `best` only ever down, `unlocked` only ever up, the
// streak walked in CALENDAR DAYS (never a timestamp difference), a corrupt payload degrading to a
// clean blank instead of a crash, and `requireBackend()` THROWING rather than returning null.
//   node test/storage.test.mjs

import { run, test, ok, eq } from '../tools/harness.mjs';
import { dayDistance, shiftDay } from '../js/core/rng.js';

let n = 0;
const KEY = 'euclid.save.v1';

function fakeLS(initial = new Map()) {
  const m = new Map(initial);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    clear: () => m.clear(),
    get length() { return m.size; },
    _map: m,
  };
}

// Load storage.js with (or without) a window, fresh each time.
async function fresh(ls) {
  if (ls === null) delete globalThis.window;
  else globalThis.window = { localStorage: ls };
  const mod = await import(`../js/core/storage.js?n=${++n}`);
  return mod;
}

test('storage: 存档键名与 schema 只有一个字符串', () => {
  eq(KEY, 'euclid.save.v1');
});

test('storage: node 进程里没有可持久化的存档 —— requireBackend 抛异常而不是返回 null', async () => {
  const m = await fresh(null);
  eq(m.SAVE_KEY, KEY);
  let err = null;
  try { m.requireBackend(); } catch (e) { err = e; }
  ok(err, '没有 window 却不抛，就是把「拒绝」当成了「空」');
  eq(err instanceof m.StorageError, true);
  ok(/no window/.test(err.message), err.message);
  eq(m.persistent(), false, '没有后端时 persistent 必须说实话');
});

test('storage: localStorage 不存在时同样抛，而不是给一个 null', async () => {
  const m = await fresh(undefined);
  globalThis.window = {};
  let err = null;
  try { m.requireBackend(); } catch (e) { err = e; }
  ok(err && /localStorage 不存在/.test(err.message), String(err && err.message));
  eq(m.persistent(), false);
});

test('storage: 写一次就是一个键，读回来是同一份 JSON', async () => {
  const ls = fakeLS();
  const m = await fresh(ls);
  eq(Object.keys(m.store.records).length, 0, '新会话应该是空的');
  eq(ls._map.size, 0, '没有写过就不该有键');
  const rec = m.store.finish('nugget-01', { won: true, plies: 5, hints: 0 });
  eq(rec.best, 5);
  eq(rec.won, true);
  eq(rec.clean, true, '零提示通关才是干净的');
  eq(ls._map.size, 1, `只允许一个键，实际 ${[...ls._map.keys()]}`);
  eq([...ls._map.keys()][0], KEY);
  const parsed = JSON.parse(ls.getItem(KEY));
  eq(parsed.records['nugget-01'].best, 5);
  eq(parsed.stats.plays, 1);
  eq(parsed.unlocked, 1);
  eq(m.persistent(), true);
});

test('storage: 单键往返 —— 换一个实例读同一份磁盘就复原', async () => {
  const ls = fakeLS();
  const a = await fresh(ls);
  a.store.finish('vein-02', { won: true, plies: 4, hints: 1 });
  a.store.unlock(7);
  a.store.markDaily('2026-05-04', 'daily-2026-05-04', { won: true });
  const b = await fresh(ls);
  eq(b.store.record('vein-02').best, 4);
  eq(b.store.record('vein-02').plays, 1, 'plays 往返');
  eq(b.store.unlocked, 7);
  eq(b.store.dailyDone('2026-05-04').won, true);
  eq(b.store.totals().wins, 1);
  eq(b.store.streak('2026-05-04'), 1);
});

test('storage: best 只降不升，输一局不毁纪录', async () => {
  const m = await fresh(fakeLS());
  eq(m.store.finish('x', { won: true, plies: 6, hints: 0 }).best, 6);
  eq(m.store.finish('x', { won: true, plies: 9, hints: 2 }).best, 6, '更慢的一局不能抬高 best');
  eq(m.store.finish('x', { won: false, plies: 40, hints: 0 }).best, 6, '输了也不动 best');
  eq(m.store.finish('x', { won: true, plies: 3, hints: 0 }).best, 3, '更快才降');
  const r = m.store.record('x');
  eq(r.plays, 4);
  eq(r.won, true, '赢过一次就永远算通过');
  eq(r.lastWon, true, '最近一局是赢的');
  eq(r.lastPlies, 3);
  eq(r.clean, true, '之前有过一次零提示的胜');
  m.store.finish('x', { won: false, plies: 8, hints: 1 });
  eq(m.store.record('x').lastWon, false, '「最近一局」与「通过过」是两回事');
  eq(m.store.record('x').best, 3, '再输也不动纪录');
  const t = m.store.totals();
  // hand-derived plies: 6 + 9 + 40 + 3 + 8 = 66, of which two wins (6, 9), three losses (40, 3? no)
  eq([t.cleared, t.plays, t.wins, t.losses, t.plies, t.bestTotal], [1, 5, 3, 2, 66, 3]);
});

test('storage: unlocked 只升不降', async () => {
  const m = await fresh(fakeLS());
  eq(m.store.unlock(5), 5);
  eq(m.store.unlock(2), 5);
  eq(m.store.unlock(0), 5);
  eq(m.store.unlock('9'), 9, '字符串是路由给的，按数值处理');
  eq(m.store.unlock(-3), 9);
  eq(m.store.unlock(undefined), 9);
  eq(m.store.unlocked, 9);
});

test('storage: 提示计数进 stats 也进那一关的记录', async () => {
  const m = await fresh(fakeLS());
  eq(m.store.hint('y').hints, 1);
  eq(m.store.hint('y').hints, 2);
  eq(m.store.stats.hints, 2);
  m.store.finish('y', { won: true, plies: 3, hints: 2 });
  eq(m.store.record('y').clean, false, '用过提示就不干净');
  eq(m.store.totals().hints, 4, 'finish 里的 hints 也累加到总账');
});

test('storage: daily 一旦赢了就擦不掉，另一天不受影响', async () => {
  const m = await fresh(fakeLS());
  m.store.markDaily('2026-06-01', 'daily-2026-06-01', { won: true });
  eq(m.store.markDaily('2026-06-01', 'other-id', { won: false }), { id: 'daily-2026-06-01', won: true });
  eq(m.store.dailyDone('2026-06-01').won, true);
  eq(m.store.dailyDone('2026-06-02'), null);
  eq(m.store.markDaily('2026-06-02', 'daily-2026-06-02', { won: false }).won, false);
});

test('storage: markDaily 拒绝不像日期的键', async () => {
  const m = await fresh(fakeLS());
  for (const bad of ['', '2026-6-1', 'yesterday', null]) {
    let err = null;
    try { m.store.markDaily(bad, 'x', {}); } catch (e) { err = e; }
    ok(err && /需要 YYYY-MM-DD/.test(err.message), `${JSON.stringify(bad)} -> ${err && err.message}`);
  }
});

test('storage: 连续天数按日历走，不是按时间戳差', async () => {
  const m = await fresh(fakeLS());
  for (const d of ['2026-03-01', '2026-02-27', '2026-02-28', '2026-03-02', '2026-02-26']) {
    m.store.markDaily(d, `daily-${d}`, { won: true });
  }
  eq(m.store.streak('2026-03-01'), 4, '2/26…3/01 连四天');
  eq(m.store.streak('2026-02-28'), 3);
  eq(m.store.streak('2026-02-26'), 1);
  // today unfinished must NOT break a run that is still alive: the walk starts yesterday
  eq(m.store.streak('2026-03-02'), 5, '今天还没打也不该断');
  m.store.markDaily('2026-03-03', 'daily-2026-03-03', { won: false });
  eq(m.store.streak('2026-03-03'), 5, '今天输了：从昨天往前数');
  // a gap kills it dead
  m.store.markDaily('2026-04-01', 'daily-2026-04-01', { won: true });
  eq(m.store.streak('2026-04-01'), 1);
  eq(m.store.streak('1999-01-01'), 0);
});

test('storage: 跨月、跨年、闰日的 shiftDay 都是手推得出来的', () => {
  // hand-derived: Feb 2026 has 28 days (2026 is not a multiple of 4)
  eq(shiftDay('2026-03-01', -1), '2026-02-28');
  // 2024 IS a leap year (divisible by 4, not by 100)
  eq(shiftDay('2024-03-01', -1), '2024-02-29');
  // 1900-style century rule, checked through the UTC Date this uses: 2000 was a leap year
  eq(shiftDay('2000-03-01', -1), '2000-02-29');
  eq(shiftDay('2026-01-01', -1), '2025-12-31', '跨年不能凭空多出一天');
  eq(shiftDay('2026-12-31', 1), '2027-01-01');
  eq(shiftDay('2026-05-31', -30), '2026-05-01');
  eq(dayDistance('2026-02-27', '2026-03-02'), 3);
  eq(dayDistance('2026-03-02', '2026-02-27'), -3);
  for (const bad of ['2026-3-1', '', 'nope']) {
    let err = null;
    try { shiftDay(bad, 1); } catch (e) { err = e; }
    ok(err && /需要 YYYY-MM-DD/.test(err.message), `${bad} 竟然没被拒`);
  }
});

test('storage: 损坏的存档降级成空白，而不是把页面搞崩', async () => {
  for (const junk of ['{', 'not json at all', '[]', 'null', '"a string"', '0', '', 'NaN']) {
    const ls = fakeLS(new Map([[KEY, junk]]));
    const m = await fresh(ls);
    eq(m.store.records, {}, `${junk} 应该读成空记录`);
    eq(m.store.unlocked, 1);
    eq(m.store.totals().plays, 0);
    eq(m.store.daily, {});
  }
});

test('storage: 半坏的字段逐个修，坏的日记键直接丢', async () => {
  const payload = {
    records: { a: { best: 4, won: true }, b: 'garbage' },
    daily: { '2026-05-01': { id: 'd1', won: true }, '2026-5-1': { id: 'bad', won: true }, nope: 3 },
    unlocked: 'many',
    stats: { plays: -5, wins: 2.9, losses: null, plies: '12', hints: undefined },
  };
  const ls = fakeLS(new Map([[KEY, JSON.stringify(payload)]]));
  const m = await fresh(ls);
  eq(Object.keys(m.store.daily), ['2026-05-01'], '日历键不合格就不能进连击的输入');
  eq(m.store.unlocked, 1, '"many" 不是数字，退回 1');
  const s = m.store.stats;
  eq([s.plays, s.wins, s.losses, s.plies, s.hints], [0, 2, 0, 12, 0]);
  eq(m.store.record('a').best, 4, '一条坏记录不该拖累好的');
  eq(m.store.streak('2026-05-01'), 1);
});

test('storage: reset 把内存与磁盘一起清空', async () => {
  const ls = fakeLS();
  const m = await fresh(ls);
  m.store.finish('z', { won: true, plies: 3, hints: 0 });
  ok(ls.getItem(KEY));
  m.store.reset();
  eq(ls.getItem(KEY), null);
  eq(Object.keys(m.store.records).length, 0);
  eq(m.store.unlocked, 1);
  eq(m.store.totals().plays, 0);
});

test('storage: 存储被拒（配额 / 隐私窗口）时游戏照样能玩', async () => {
  const ls = fakeLS();
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  const m = await fresh(ls);
  eq(m.persistent(), false, '探针必须说实话');
  const rec = m.store.finish('q', { won: true, plies: 5, hints: 0 });
  eq(rec.best, 5, '写不进去也要记住这一局，只是出了这个页面就忘');
  eq(ls._map.size, 0, '什么都没落盘');
  eq(m.store.record('q').best, 5, '内存里是有的');
});

test('storage: 写进去的 JSON 不带函数、不带 undefined，重新解析还是同一份', async () => {
  const ls = fakeLS();
  const m = await fresh(ls);
  m.store.finish('r', { won: false, plies: 7 });
  m.store.unlock(3);
  const raw = ls.getItem(KEY);
  ok(raw.length < 4000, `存档不该膨胀：${raw.length} 字节`);
  const again = JSON.parse(raw);
  eq(Object.keys(again).sort(), ['daily', 'records', 'stats', 'unlocked', 'v'], '顶层多一个 v：存档格式带版本号');
  eq(again.v, 1, 'v 就是本仓的 SAVE_VERSION');
  eq(again.records.r.best, undefined, '输了的记录落盘时没有 best 字段（读档时才归一成 null）');
  eq(again.records.r.lastPlies, 7);
  eq(again.unlocked, 3);
});

await run();
