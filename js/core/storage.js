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

export const SAVE_KEY = KEY;

export class StorageError extends Error {}

export function requireBackend() {
  if (typeof window === 'undefined') throw new StorageError('no window: node 进程里没有可持久化的存档');
  if (!window.localStorage) throw new StorageError('window.localStorage 不存在');
  return window.localStorage;
}

function backend() {
  try {
    return requireBackend();
  } catch {
    return null; // memory-only session: the game still plays, it just forgets
  }
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { plays: 0, wins: 0, losses: 0, plies: 0, hints: 0 },
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = ls ? ls.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        const s = (p.stats && typeof p.stats === 'object') ? p.stats : {};
        const daily = {};
        if (p.daily && typeof p.daily === 'object') {
          // Day keys are the streak's input, so a corrupt key is dropped rather than counted:
          // accepting "2026-9-3" or "yesterday" would silently break shiftDay's walk.
          for (const [k, v] of Object.entries(p.daily)) {
            if (DAY_RE.test(k) && v && typeof v === 'object') daily[k] = { id: String(v.id ?? ''), won: !!v.won };
          }
        }
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily,
          unlocked: count(p.unlocked) || base.unlocked,
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
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch {
    return false; // quota or a blocked store: the session simply stays in memory
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

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
    const ls = backend();
    if (ls) {
      try {
        ls.removeItem(KEY);
      } catch {
        /* nothing was ever persisted */
      }
    }
    return cache;
  },
};

// Which backing store this session actually got. Goes through the throwing probe on purpose:
// `false` here means the store REFUSED, not that it happens to be empty.
export function persistent() {
  try {
    const ls = requireBackend();
    ls.setItem(PROBE, '1');
    ls.removeItem(PROBE);
    return true;
  } catch {
    return false;
  }
}
