// The save file: ONE localStorage key, plain JSON, versioned shape.
//
// This is the only module under js/core that is allowed to mention `window`, and it is guarded:
// `node` imports this file with no window at all, and a browser may refuse storage (private
// window, blocked third-party context, quota). The rules the repo follows:
//   * reading degrades to an in-memory blank, so the game is always playable;
//   * asking whether the session REALLY persists goes through `requireBackend()`, which THROWS
//     instead of returning null. A probe that answers "no storage" by handing back `null` cannot
//     tell a refused store apart from an empty one, and that difference is exactly what the
//     @save suite in tools/playtest.mjs asserts.
//
// Two monotonicities are the whole design, and test/storage.test.mjs writes them out of order to
// prove them: `best` (fewest plies to clear a lot) only ever goes DOWN, `unlocked` only ever goes
// UP. A third invariant lives here too: the daily STREAK is derived from calendar-day arithmetic
// over the recorded day keys (js/core/rng.js `shiftDay`), never from a timestamp difference — a
// wall-clock subtraction turns a 25-hour gap into two missed days or a 23-hour one into a free
// day, and either bug is invisible until someone flies home.

import { shiftDay } from './rng.js';

const KEY = 'euclid.save.v1';
const PROBE = 'euclid.probe';
// 存档格式版本号。**写档不带这一段**（闸 test/storage.test.mjs 定死了存档恰好五段：
// daily / records / settings / stats / unlocked），但**读档认它**：见到不认识的版本号
// 整档丢弃，绝不把新格式当旧格式读。将来升 v2 时，写端加上 `v: 2`，旧客户端这一条
// 就会把新档丢掉而不是误读。
export const SAVE_VERSION = 1;

export const SAVE_KEY = KEY;

export class StorageError extends Error {}

export function requireBackend() {
  if (typeof window === 'undefined') throw new StorageError('no window: node 进程里没有可持久化的存档');
  if (!window.localStorage) throw new StorageError('window.localStorage 不存在');
  return window.localStorage;
}

function available() {
  try {
    requireBackend();
    return true;
  } catch {
    return false; // memory-only session: the game still plays, it just forgets
  }
}

// 整个仓只准这四个函数碰持久层 —— 收口在一处，"读回来的是不是同一份 JSON"就只有一个地方要证。
// 后端拒绝（隐私窗口、无 window、配额）时它们给 null/false，而不是抛：存档丢了不许把页面搞崩。
function readItem(key) {
  if (!available()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(key, value) {
  if (!available()) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false; // 配额或被拦：这一次会话就留在内存里
  }
}

function dropItem(key) {
  if (!available()) return false;
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 一手棋之后长边严格变小（切完剩 a-kb < a，再把 b 换边），而发货棋书的边界是 60 ——
// 所以任何一局的总手数不可能超过 60。超过 60 的 best 不是"这人打得久"，是脏数据。
const MAX_PLIES = 60;

// 第二段解码：一条记录自己判自己，坏的那条丢掉，别让整份存档陪葬。
function decodeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = {
    plays: count(raw.plays),
    won: !!raw.won,
    lastWon: !!raw.lastWon,
    lastPlies: Math.min(count(raw.lastPlies), MAX_PLIES),
    hints: count(raw.hints),
    clean: !!raw.clean,
  };
  const best = count(raw.best);
  if (best && best <= MAX_PLIES) rec.best = best;
  // 一条没有任何信号的记录（没打过、没赢过、没帕数）不值得占键：留着它只会让"通关数"错。
  if (!rec.plays && !rec.won && !rec.best && !rec.hints) return null;
  return rec;
}

function decodeDaily(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return { id: String(raw.id ?? ''), won: !!raw.won };
}

// 设置只有这几个键会被读回来，且各自按类型解码：一个脏的 muted 不该让整个存档变成脏的。
export const SETTINGS = { muted: Boolean, showTutorial: Boolean };

function decodeSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, cast] of Object.entries(SETTINGS)) {
    if (raw[k] === undefined) continue;
    out[k] = cast(raw[k]);
  }
  return out;
}

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { plays: 0, wins: 0, losses: 0, plies: 0, hints: 0 },
    settings: {},
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  const raw = readItem(KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      // 版本门：只认本仓写出去的版本。旧档（没有 v 段）照读，陌生版本整档丢弃。
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        const s = (p.stats && typeof p.stats === 'object' && !Array.isArray(p.stats)) ? p.stats : {};
        const records = {};
        if (p.records && typeof p.records === 'object' && !Array.isArray(p.records)) {
          for (const [id, entry] of Object.entries(p.records)) {
            const rec = decodeRecord(entry);
            if (rec) records[id] = rec;
          }
        }
        const daily = {};
        if (p.daily && typeof p.daily === 'object' && !Array.isArray(p.daily)) {
          // Day keys are the streak's input, so a corrupt key is dropped rather than counted:
          // accepting "2026-9-3" or "yesterday" would silently break shiftDay's walk.
          for (const [k, entry] of Object.entries(p.daily)) {
            const day = DAY_RE.test(k) ? decodeDaily(entry) : null;
            if (day) daily[k] = day;
          }
        }
        cache = {
          records,
          daily,
          unlocked: count(p.unlocked) || base.unlocked,
          settings: decodeSettings(p.settings),
          stats: {
            plays: count(s.plays),
            wins: count(s.wins),
            losses: count(s.losses),
            plies: count(s.plies),
            hints: count(s.hints),
          },
        };
        return cache;
      }
    } catch {
      // A corrupt save is not worth keeping: start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  return writeItem(KEY, JSON.stringify(cache));
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },
  get settings() { return load().settings; },

  // 只认 SETTINGS 里列过的键：写一个没听过的键名，得到的不是"存下来了"而是一个异常，
  // 否则拼错一个字母就会造出一个没人读的第二个真相源。
  setSetting(key, value) {
    if (!Object.prototype.hasOwnProperty.call(SETTINGS, key)) {
      throw new RangeError(`setSetting: 不认识的设置键 ${JSON.stringify(String(key))}`);
    }
    const s = load();
    s.settings[key] = SETTINGS[key](value);
    persist();
    return s.settings[key];
  },

  record(id) {
    return load().records[id] || null;
  },

  // A finished match. `plies` counts BOTH seats, which is the unit the lot card and the book print
  // as 帕, so "cleared in n plies" is directly comparable with par. A loss never overwrites an
  // earlier win's `best`, and `best` only moves down.
  finish(id, { won, plies, hints }) {
    const s = load();
    const prev = s.records[id] || null;
    const took = count(plies);
    const was = count(prev && prev.best);
    const best = won ? (was ? Math.min(was, took) : took) : was;
    const cur = {
      plays: count(prev && prev.plays) + 1,
      won: !!(prev && prev.won) || !!won,
      lastWon: !!won,
      lastPlies: took,
      ...(best ? { best } : {}),
      clean: !!(prev && prev.clean) || !!(won && !count(hints)),
    };
    s.records[id] = cur;
    s.stats.plays += 1;
    s.stats.plies += took;
    s.stats.wins += won ? 1 : 0;
    s.stats.losses += won ? 0 : 1;
    s.stats.hints += count(hints);
    persist();
    return cur;
  },

  hint(id) {
    const s = load();
    s.stats.hints += 1;
    const prev = s.records[id] || { plays: 0, won: false, lastWon: false, lastPlies: 0 };
    s.records[id] = { ...prev, hints: count(prev.hints) + 1 };
    persist();
    return s.records[id];
  },

  unlock(n) {
    const s = load();
    if (count(n) > s.unlocked) s.unlocked = count(n);
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id, { won } = {}) {
    if (!DAY_RE.test(String(dateKey))) throw new RangeError('markDaily: 需要 YYYY-MM-DD，收到 ' + JSON.stringify(String(dateKey)));
    const s = load();
    const prev = s.daily[dateKey];
    // Once a day is won it stays won: re-losing the daily must not erase the mark.
    if (prev && prev.won && !won) {
      s.daily[dateKey] = { id: prev.id, won: true };
    } else {
      s.daily[dateKey] = { id: String(id), won: !!won };
    }
    persist();
    return s.daily[dateKey];
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  // The streak, counted BACKWARDS from `today` in calendar days. If today is not won yet the walk
  // starts at yesterday, so an unfinished today does not break a run that is still alive.
  streak(today, limit = 400) {
    if (!DAY_RE.test(String(today))) throw new RangeError('streak: 需要 YYYY-MM-DD，收到 ' + JSON.stringify(String(today)));
    const s = load();
    const wonDay = (k) => !!(s.daily[k] && s.daily[k].won);
    let cur = wonDay(today) ? today : shiftDay(today, -1);
    let n = 0;
    while (n < limit && wonDay(cur)) {
      n++;
      cur = shiftDay(cur, -1);
    }
    return n;
  },

  totals() {
    const s = load();
    let cleared = 0;
    let bestTotal = 0;
    for (const r of Object.values(s.records)) {
      if (r && r.won) cleared++;
      if (r && count(r.best)) bestTotal += count(r.best);
    }
    return {
      cleared,
      plays: s.stats.plays,
      wins: s.stats.wins,
      losses: s.stats.losses,
      hints: s.stats.hints,
      plies: s.stats.plies,
      bestTotal,
    };
  },

  reset() {
    cache = blank();
    dropItem(KEY);
    return cache;
  },
};

// Which backing store this session actually got. Goes through the throwing probe on purpose:
// `false` here means the store REFUSED, not that it happens to be empty.
export function persistent() {
  try {
    requireBackend();
    window.localStorage.setItem(PROBE, '1');
    window.localStorage.removeItem(PROBE);
    return true;
  } catch {
    return false;
  }
}
