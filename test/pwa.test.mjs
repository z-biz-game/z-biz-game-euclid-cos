// 发货的 PWA 外壳：manifest、service worker、以及静态服务对每一个资产路径的回答。
//
// 为什么在 node 里测 sw.js：本仓的浏览器套件由另一条线跑，而"网络优先"这类话写在注释里
// 不算数 —— 一个把 `caches.match` 放在 `fetch` 前面的 sw.js，在有网的开发机上永远是绿的，
// 只有断网那一次才暴露。所以这里把 sw.js 当成可执行模块，喂进一个最小 ServiceWorker 全局
// （self / caches / clients / fetch / Response），真的触发它的 fetch 事件，看它返回什么。
//
// 判据的形状：联网那一次必须用网络的答案并回填；**掐网**之后必须回落到缓存里的那一份；
// 导航回落壳、缺席的子资源不许回落壳（否则 JS 会拿到一份 HTML）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ok, run, test } from '../tools/harness.mjs';
import { pwaStatus, registerServiceWorker } from '../js/pwa.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---------------------------------------------------------------- 资产与静态服务
// 社交标签（og:image / twitter:image）必须是绝对 URL，爬虫才接受；那意味着按相对路径扫描的
// 这张表会漏掉 og-card —— 所以这里把它折回相对路径，一起受"200、MIME 对、非 0 字节"的约束。
// 部署域与 tools/check_site.mjs 的 SITE 必须同值，下面的测试专门钉这一对。
export const SITE_ORIGIN = 'https://z-biz-game.github.io/z-biz-game-euclid-cos/';

function shippedRefs() {
  const refs = new Set();
  const scan = (text, re) => { for (const m of text.matchAll(re)) refs.add(m[1]); };
  scan(read('index.html'), /(?:href|src|content)="((?:icons|textures|social|css|js)\/[^"]+|manifest\.webmanifest)"/g);
  scan(read('index.html'), new RegExp(`content="${SITE_ORIGIN}((?:icons|textures|social|css|js)/[^"]+)"`, 'g'));
  scan(read('css/game.css'), /url\("((?:\.\.\/)?(?:icons|textures|social)\/[^"]+)"\)/g);
  for (const ic of JSON.parse(read('manifest.webmanifest')).icons) refs.add(ic.src);
  return [...refs].map((r) => r.replace(/^\.\.\//, ''));
}

function withServer(fn) {
  const req = createRequire(import.meta.url);
  const { startServer } = req('../server.cjs');
  return startServer({ port: 0, root: ROOT }).then(async (server) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      return await fn(base);
    } finally {
      server.close();
    }
  });
}

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

// ---------------------------------------------------------------- service worker 沙箱
// 一个只认 URL 的最小 CacheStorage。两条忠实性要求都是浏览器的真行为：
//   * 键按 worker 自己的 origin 归一 —— `caches.match('index.html')` 在浏览器里相对 sw 的 URL
//     解析；换个基准就永远 miss，而那正是"离线壳回落"这条分支。
//   * 匹配忽略 #fragment：导航请求的 URL 从不携带 fragment。
function makeCaches(origin, net) {
  const stores = new Map();
  const key = (req) => {
    const u = new URL(typeof req === 'string' ? req : req.url, `${origin}/`);
    u.hash = '';
    return u.href;
  };
  const mapOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  return {
    stores,
    open: async (name) => {
      const m = mapOf(name);
      return {
        put: async (req, res) => { m.set(key(req), res.clone()); },
        match: async (req) => {
          const hit = m.get(key(req));
          return hit ? hit.clone() : undefined;
        },
        add: async (req) => {
          const res = await net(req);
          if (!res.ok) throw new Error(`add ${key(req)} -> ${res.status}`);
          m.set(key(req), res.clone());
        },
      };
    },
    // CacheStorage.match 是浏览器真有的静态方法（sw 的离线回落就是走它跨桶找），
    // 按写入顺序返回第一个命中。
    match: async (req) => {
      const want = key(req);
      for (const m of stores.values()) {
        const hit = m.get(want);
        if (hit) return hit.clone();
      }
      return undefined;
    },
    has: (name) => stores.has(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
}

// `state.offline = true` 之后所有网络调用都 reject —— 那是断网，不是模拟一个假响应。
function loadSW({ origin = 'http://sw.test' } = {}) {
  const events = {};
  const state = { offline: false, netCalls: 0, skipWaitingCalls: 0, claimCalls: 0 };

  async function net(req) {
    state.netCalls++;
    if (state.offline) throw new TypeError('Failed to fetch');
    const url = new URL(typeof req === 'string' ? req : req.url, `${origin}/`);
    const res = new Response(`NET:${url.pathname}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    // 浏览器里同源 fetch 的 type 就是 'basic'，node 的 Response 构造给 'default'；sw 只缓存
    // basic，不补这一层就永远测不到回填那条分支。
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  }

  const caches = makeCaches(origin, net);
  const sandbox = {
    console,
    setTimeout,
    URL,
    Response,
    Request,
    Promise,
    Error,
    caches,
    location: { origin, href: `${origin}/sw.js` },
    clients: { claim: async () => { state.claimCalls++; } },
    skipWaiting: () => { state.skipWaitingCalls++; return Promise.resolve(); },
    fetch: (req) => net(req),
  };
  sandbox.self = sandbox;
  sandbox.addEventListener = (type, fn) => { events[type] = fn; };
  vm.createContext(sandbox);
  vm.runInContext(read('sw.js'), sandbox, { filename: 'sw.js' });

  const wait = { waitUntil: (p) => p };
  const fire = async (reqLike) => {
    let captured = null;
    await events.fetch({ request: reqLike, respondWith: (p) => { captured = p; } });
    return captured || null;                      // null = sw 明确放手，交回浏览器
  };
  // sw 的回填是 fire-and-forget（它不许让一次缓存写拖慢响应），断言前过一次宏任务队列。
  const settle = () => new Promise((r) => { setImmediate(() => setImmediate(r)); });
  return { events, caches, state, fire, settle, wait, sandbox };
}

const req = (url, { method = 'GET', mode = 'cors' } = {}) => new Request(url, { method, mode });
// undici 的 Request 构造拒绝 mode:'navigate'（浏览器接受）。sw 只读 method/url/mode 并把对象
// 交给 fetch 与 caches.match，所以这里用一个 request-like 对象，比把 mode 改成别的更诚实。
const navReq = (url) => ({ url, method: 'GET', mode: 'navigate' });
const boot = async ({ events, wait }) => {
  await events.install(wait);
  await events.activate(wait);
};

// ---------------------------------------------------------------- 盘上清单
test('发货清单：页面/manifest/css 引用的每一条路径都在盘上', () => {
  const refs = shippedRefs();
  const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  assert.deepEqual(missing, [], `盘上缺: ${missing.join(', ')}`);
  ok(refs.length >= 16, `引用数只有 ${refs.length}，说明扫描没吃到东西`);
});

test('静态服务：每一条引用都 200、MIME 对、且没有 0 字节', async () => {
  await withServer(async (base) => {
    const bad = [];
    for (const rel of shippedRefs()) {
      const { res, body } = await get(`${base}/${rel}`);
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200) bad.push(`${rel}:${res.statusCode}`);
      else if (body.length === 0) bad.push(`${rel}:0B`);
      else if (rel.endsWith('.png') && !type.startsWith('image/png')) bad.push(`${rel}:${type}`);
      else if (rel.endsWith('.js') && !type.startsWith('text/javascript')) bad.push(`${rel}:${type}`);
      else if (rel.endsWith('.css') && !type.startsWith('text/css')) bad.push(`${rel}:${type}`);
      else if (rel.endsWith('.webmanifest') && !type.startsWith('application/manifest+json')) bad.push(`${rel}:${type}`);
    }
    assert.deepEqual(bad, [], `服务答错: ${bad.join(' ')}`);
  });
});

test('manifest 是合法 JSON，且"装得上"要的四样都在', () => {
  const mf = JSON.parse(read('manifest.webmanifest'));
  ok(mf.name && mf.short_name, '缺 name/short_name');
  ok(mf.start_url === './' && mf.scope === './', `start_url/scope 必须相对：${mf.start_url} ${mf.scope}`);
  ok(mf.display === 'standalone', `display=${mf.display}`);
  ok(mf.theme_color && mf.background_color, '缺配色');
  ok(mf.icons.some((i) => Number.parseInt(String(i.sizes), 10) >= 512), '没有 ≥512 的图标，装不进桌面');
  const maskable = mf.icons.filter((i) => i.purpose === 'maskable');
  ok(maskable.length >= 1, '没有 maskable 图标');
  ok(maskable.every((i) => Number.parseInt(String(i.sizes), 10) >= 512), 'maskable 必须 ≥512');
});

test('manifest 的每条 icons[].src 都是盘上真 PNG，且 IHDR 尺寸与标称一致', () => {
  const wrong = [];
  for (const ic of JSON.parse(read('manifest.webmanifest')).icons) {
    const buf = fs.readFileSync(path.join(ROOT, ic.src));
    assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${ic.src} 不是 PNG`);
    const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    const [dw, dh] = String(ic.sizes).split('x').map(Number);
    if (w !== dw || h !== dh) wrong.push(`${ic.src}: 盘上 ${w}x${h} 标称 ${dw}x${dh}`);
  }
  assert.deepEqual(wrong, [], wrong.join(' / '));
});

// ---------------------------------------------------------------- 社交卡
// 分享出去的那张卡是纯文本还是带图，取决于这几条机器能判的规矩：爬虫只吃绝对 URL（相对路径会被
// 原样丢给解析器）、og:image:width/height 是宣称值所以必须和 IHDR 实测对得上，以及页面与工具两处
// 部署域必须是同一个字符串 —— 三样都会在改域名/换图时漂，漂了卡就悄悄没了图。
test('社交卡：标签齐全、URL 绝对、宣称尺寸对得上 IHDR 实测', () => {
  const html = read('index.html');
  const tag = (re) => (html.match(re) || [])[1];
  ok(tag(/property="og:url"\s+content="([^"]+)"/) === SITE_ORIGIN, `og:url 必须逐字等于部署域 ${SITE_ORIGIN}`);
  const ogImg = tag(/property="og:image"\s+content="([^"]+)"/);
  const twImg = tag(/name="twitter:image"\s+content="([^"]+)"/);
  ok(ogImg && ogImg.startsWith(SITE_ORIGIN), `og:image 必须是部署域下的绝对 URL，实际 ${JSON.stringify(ogImg)}`);
  ok(twImg && twImg.startsWith(SITE_ORIGIN), `twitter:image 必须是绝对 URL，实际 ${JSON.stringify(twImg)}`);
  ok(tag(/name="twitter:card"\s+content="([^"]+)"/) === 'summary_large_image', 'twitter:card 不是大图卡，1200×630 会被裁成小方图');
  for (const re of [/property="og:title"/, /property="og:description"/, /name="twitter:title"/,
    /name="twitter:description"/, /property="og:image:alt"/, /name="twitter:image:alt"/]) {
    const m = html.match(new RegExp(re.source + '\\s+content="([^"]+)"'));
    ok(m && m[1].length > 8, `缺标签或内容为空：${re.source}`);
  }
  const w = Number(tag(/property="og:image:width"\s+content="(\d+)"/));
  const h = Number(tag(/property="og:image:height"\s+content="(\d+)"/));
  const buf = fs.readFileSync(path.join(ROOT, ogImg.slice(SITE_ORIGIN.length)));
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${ogImg} 指向的不是一张 PNG`);
  const [aw, ah] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  assert.equal(aw, w, `og:image:width 宣称 ${w}，IHDR 实测 ${aw}`);
  assert.equal(ah, h, `og:image:height 宣称 ${h}，IHDR 实测 ${ah}`);
  // 页面与产物自检两处部署域必须同值，否则"折回相对路径"这一步在其中一个里悄悄失效。
  ok(read('tools/check_site.mjs').includes(`const SITE = '${SITE_ORIGIN}';`),
    'tools/check_site.mjs 的 SITE 与这里的 SITE_ORIGIN 分叉了');
});

// ---------------------------------------------------------------- 网络优先
test('sw 联网那一次：用网络的答案，并把它回填进缓存', async () => {
  const { events, caches, fire, settle, state, wait } = loadSW();
  await boot({ events, wait });
  const r = req('http://sw.test/js/main.js');
  const res = await fire(r);
  assert.equal(await res.text(), 'NET:/js/main.js', '网络可用时不许读缓存');
  assert.equal(state.skipWaitingCalls, 1, 'install 没有 skipWaiting，更新要等一个冷启动');
  await settle();
  const names = await caches.keys();
  ok(names.length === 1 && names[0].startsWith('euclid-pwa-'), `缓存桶名不对: ${names.join(',')}`);
  ok(await (await caches.open(names[0])).match(r), '打赢了网络却没回填，断网就什么都没有');
});

test('sw 断网那一次：同源子资源回落到缓存里的那一份', async () => {
  const { events, fire, settle, state, wait } = loadSW();
  await boot({ events, wait });
  const r = req('http://sw.test/css/game.css');
  await (await fire(r)).text();
  await settle();
  state.offline = true;
  assert.equal(await (await fire(r)).text(), 'NET:/css/game.css', '断网时没能回落到缓存');
  assert.ok(state.netCalls >= 2, '断网后一次网络都没打 —— 那不是"网络优先"');
});

test('sw 离线壳：导航回落到壳，缺席的子资源不许拿到壳', async () => {
  const { events, fire, settle, state, wait } = loadSW();
  await boot({ events, wait });
  await settle();                                 // install 预取的壳要落地
  state.offline = true;
  const nav = await fire(navReq('http://sw.test/lot/nugget-01'));
  ok(nav, '导航请求被放手了，离线打开会白屏');
  const navRes = await nav;
  assert.equal(navRes.status, 200, '离线导航没拿到壳');
  assert.equal(await navRes.text(), 'NET:/index.html');
  const miss = await fire(req('http://sw.test/js/nope.js'));
  const missRes = await miss;
  assert.notEqual(await missRes.text(), 'NET:/index.html', '子资源回落成 index.html —— JS 会拿到一份 HTML');
  ok(!missRes.ok, '缺席的子资源伪装成了一次成功');
});

test('sw 不接管：非 GET、跨源、以及解析不了的 URL', async () => {
  const { events, fire, wait } = loadSW();
  await boot({ events, wait });
  assert.equal(await fire(req('http://sw.test/x', { method: 'POST' })), null, 'POST 被接管了');
  assert.equal(await fire(req('https://elsewhere.test/a.js')), null, '跨源被接管了');
  assert.equal(await fire({ method: 'GET', url: 'data:text/javascript,1' }), null, 'data: 被接管了');
});

test('sw 升级清旧桶：换一个 VERSION 号安装时，上一版缓存不留着', async () => {
  const { events, caches, fire, settle, wait } = loadSW();
  await events.install(wait);
  await caches.open('euclid-pwa-v0');             // 上一版留下的桶
  await (await fire(req('http://sw.test/a.js'))).text();
  await settle();
  const current = (await caches.keys()).find((k) => k !== 'euclid-pwa-v0');
  ok(current && current.startsWith('euclid-pwa-'), `找不到当版本的桶: ${(await caches.keys()).join(',')}`);
  await events.activate(wait);
  ok(!caches.has('euclid-pwa-v0'), '旧桶没清掉，缓存只会越积越大');
  ok(caches.has(current), '把当版本的桶一起删了 —— 离线就什么都没了');
});

test('node 进程里 registerServiceWorker 只报告、不抛异常', async () => {
  const st = await registerServiceWorker();
  assert.equal(st, pwaStatus, '返回值必须是同一个状态对象，页面才拿得到后续更新');
  assert.equal(st.registered, false);
  assert.equal(st.error, null, `不该冒泡: ${st.error}`);
  ok(st.skipped, '既没注册也没说清为什么跳过');
});

test('sw.js 里没有 cache-first：网络那一次排在回落之前', () => {
  const src = read('sw.js');
  const net = src.indexOf('fetch(req)');
  const back = src.indexOf('caches.match(');
  ok(net >= 0 && back >= 0, '缺一条路径，sw 就不是"网络优先 + 回落缓存"的形状');
  ok(net < back, 'caches.match 出现在 fetch 之前 —— 会把烘焙产物钉在旧版本');
});

run();
