// Deterministic RNG: every random position in this game is a pure function of a seed string, so
// `#/random/mint/2026-09-27` resolves to the same bar of gold on any device, and the daily draw
// is the same rectangle for everybody on the same calendar day.
//
// Why a hand-rolled generator instead of `Math.random()`: the playtest suite and the save tests
// have to replay a session exactly. A stream that cannot be re-seeded cannot be asserted on, and
// "we tested the game" would quietly mean "we tested one roll of it".

export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (str.charCodeAt(i) >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  let s = a >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  return rng;
}

export function rngFrom(seed) {
  if (typeof seed === 'function' && seed.int) return seed;
  if (typeof seed === 'number') return mulberry32(seed >>> 0);
  return mulberry32(hashSeed(String(seed)));
}

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Calendar arithmetic for the daily streak: ONE DAY, stepped through a UTC date so a local
// timezone or a DST boundary cannot invent or destroy a day. The streak is derived from these
// keys, never from a wall-clock timestamp difference. The getters are the UTC ones on purpose —
// reading a UTC-midnight instant with local getters would roll the date back in the Americas.
export function shiftDay(key, deltaDays) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!hit) throw new RangeError('shiftDay: 需要 YYYY-MM-DD，收到 ' + JSON.stringify(String(key)));
  const d = new Date(Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]) + deltaDays));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dayDistance(from, to) {
  const [ay, am, ad] = from.split('-').map(Number);
  const [by, bm, bd] = to.split('-').map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}
