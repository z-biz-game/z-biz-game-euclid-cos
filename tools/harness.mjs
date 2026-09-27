// Tiny zero-dep test framework: every test/*.mjs suite and every browser scenario prints the same
// shape, so tools/verify.sh can aggregate node rows and browser rows on one line.
//
// `test()` accepts sync or async functions — the queue is drained in registration order by
// `run()`, so a suite that needs `await import()` for module isolation (test/storage.test.mjs
// does) reports the same rows as a fully sync one. A rejected async test is a FAIL, never an
// unhandled rejection that prints nothing.
//
// One `test()` prints one row, and `rows: N fail: M` is the contract the suites are counted by.

const queue = [];
const rows = [];

export function test(name, fn) {
  queue.push(async () => {
    try {
      await fn();
      rows.push({ test: name, pass: true });
    } catch (err) {
      rows.push({ test: name, pass: false, detail: String((err && err.message) || err) });
    }
  });
}

export function ok(cond, msg = 'expected truthy') {
  if (!cond) throw new Error(msg);
}

export function eq(a, b, msg = 'not equal') {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg}\n    got      ${sa}\n    expected ${sb}`);
}

export function fail(msg) {
  throw new Error(msg);
}

export async function run() {
  while (queue.length) await queue.shift()();
  const bad = rows.filter((r) => !r.pass);
  for (const r of rows) {
    console.log(`${r.pass ? '  ok  ' : '  FAIL'} ${r.test}${r.pass ? '' : '\n         ' + r.detail}`);
  }
  console.log(`rows: ${rows.length} fail: ${bad.length}`);
  process.exit(bad.length ? 1 : 0);
}
