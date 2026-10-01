// PWA 接线：注册 service worker + 把"这台设备到底装得上吗"如实报给页面与 harness。
//
// 三条实测过的边界，缺一条就会把浏览器套件或用户拖进坑里：
//   1. **file:// 不注册**。Electron 之外有人直接双击 index.html，此时 `navigator.serviceWorker`
//      在 Chrome 里存在但注册必失败，并且抛一条红字 —— 本仓的验收里"console 干净"是一条
//      硬判据（tools/verify.sh 会 grep [error]）。所以整段按协议跳过，只留状态。
//   2. **路径按模块自己的 URL 解析**。GitHub Pages 把本仓发在 `/<repo>/` 前缀下，而
//      server.cjs 把仓当文档根 —— 根形状的服务测不出"绝对路径在前缀下 404"。上一棒就是
//      栽在这里（1435978），所以这里用 `new URL(..., import.meta.url)` 而不是 'sw.js'。
//   3. **注册失败不许冒泡**。`.catch` 收口，状态挂到 window.euclid.pwa 上，让"没装成"
//      是一个可读的事实而不是一根红条。
const PROTOCOL_OK = typeof location !== 'undefined'
  && (location.protocol === 'http:' || location.protocol === 'https:');

const status = { supported: false, registered: false, skipped: null, scope: null, error: null };

export async function registerServiceWorker() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  status.supported = !!(nav && nav.serviceWorker);
  if (!PROTOCOL_OK) {
    status.skipped = `protocol:${typeof location === 'undefined' ? 'none' : location.protocol}`;
    return status;
  }
  if (!status.supported) {
    status.skipped = 'no serviceWorker';
    return status;
  }
  try {
    const swURL = new URL('../sw.js', import.meta.url);  // js/pwa.js -> <root>/sw.js，随前缀走
    const scope = new URL('./', swURL).href;
    const reg = await nav.serviceWorker.register(swURL.href, { scope });
    status.registered = true;
    status.scope = scope;
    status.url = swURL.href;
    return status;
  } catch (err) {
    status.error = String((err && err.message) || err);
    return status;
  }
}

export const pwaStatus = status;
