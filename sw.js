/* 割金 · EUCLID 的离线壳：**网络优先，失败退缓存**。
 *
 * 为什么不是 cache-first：手工写死的 VERSION 号 + cache-first 会把 js/css 永久钉在旧版本，
 * 于是"新 HTML 配旧 JS"的鬼状态只在升级过的人身上复现，本地怎么测都是绿的。本仓的
 * js/data/lots.js 是烘焙产物（重烘一次内容就变），一旦被旧缓存钉住，页面上印出来的
 * 帕数与胜口就不再是当次发货的那本书 —— 那是这个仓最不能错的 correctness 边界。
 *
 * 因此：同源 GET 一律先打网络；打赢了顺手回填（put），打输了（断网/地铁）才回落到
 * 上次成功抓到的那份。导航请求额外兜一层缓存里的 index.html，让离线打开不白屏。
 *
 * 版本只在**缓存的键结构**要变时才升；升了会清掉旧桶（activate 里那一段）。
 */
'use strict';

const VERSION = 'v1';
const CACHE = `euclid-pwa-${VERSION}`;
const SHELL = 'index.html';
// 离线壳预取**两个键**：Cache API 按 URL 字面建索引，'./' 与 './index.html' 是两条目，
// 只灌一条的另一条就在断网时 miss —— 而回落恰恰发生在 miss 的那一边。
const SHELL_KEYS = ['.', SHELL];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(
        SHELL_KEYS.map((u) => c.add(new Request(new URL(u, self.location.href).href))),
      ))
      // 第一次安装就赶上断网：不许让 install 失败（那会把这个 worker 永久卡在 installed 之前），
      // 在线的那一次自然会回填。
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return; // 解析不了的 URL（data:/blob:）不接管，交给浏览器默认行为
  }
  if (url.origin !== self.location.origin) return;      // 外链一律不代理、不缓存
  const navigate = req.mode === 'navigate';
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        // 只有导航请求才有资格回落到壳；子资源回落成 index.html 会喂出一堆 MIME 错误
        if (navigate) return caches.match(SHELL).then((shell) => shell || Response.error());
        return Response.error();
      })),
  );
});
