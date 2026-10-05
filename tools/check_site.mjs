// tools/check_site.mjs — 发货产物自检：页面发出去的每一条引用，盘上都必须有真的字节。
//
// 为什么要有它：sellability 那类尺子读的是**仓库**，而用户点开的是**部署产物**。上一版 pages.yml
// 只拷 index.html + css/ + js/，图标、纹理、manifest、sw.js 全留在仓里没上产物 —— 仓库那一侧 17/17
// 全绿，线上却是一次装不上的 PWA 加八支 404。产物与仓库之间的这道缝，只有按产物本身来量才关得掉。
//
// 查三件事，缺一项就 exit 1：
//   1. index.html 的 href/src/content、css 的 url()、manifest 的 icons[].src、sw.js 预取的 SHELL
//      键 —— 每个都要存在，且不是 0 字节；
//   2. 位图必须是位图：读 PNG 的 IHDR 拿真实宽高，顺带核对 manifest 里声明的 sizes 是不是吹的
//      （拿 SVG 或 16px 冒充 512 是这类产物最常见的注水方式）；
//   3. 产物里不许混进服务器/工具/测试（它们只属于仓，不该被公开）。
//
//   node tools/check_site.mjs --assemble _site     # 先从仓里装配，再检（CI 与本地同一条命令）
//   node tools/check_site.mjs _site                # 只检一个已经装配好的目录
import fs from 'node:fs';
import path from 'node:path';

// 发货集合只在这里列一次：pages.yml 与本地跑的是同一支脚本，"产物里该有什么"就不会和
// "检查的是什么"分家 —— 这个 bug 正是那么长出来的：工作流注释宣称"页面上只有 index.html +
// css/ + js/ 可达"，而美术那一棒给页面添了八条真引用，仓库全绿、线上全 404。
const SHIPPED_FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];
const SHIPPED_DIRS = ['css', 'js', 'icons', 'textures', 'social'];

const argv = process.argv.slice(2);
const site = path.resolve(argv.find((a) => !a.startsWith('--')) || '_site');

if (argv.includes('--assemble')) {
  const repo = path.resolve(new URL('..', import.meta.url).pathname);
  fs.rmSync(site, { recursive: true, force: true });
  fs.mkdirSync(site, { recursive: true });
  for (const f of SHIPPED_FILES) fs.copyFileSync(path.join(repo, f), path.join(site, f));
  for (const d of SHIPPED_DIRS) fs.cpSync(path.join(repo, d), path.join(site, d), { recursive: true });
  const strays = fs.readdirSync(repo).filter((n) =>
    !SHIPPED_FILES.includes(n) && !SHIPPED_DIRS.includes(n) && !n.startsWith('.') && n !== 'node_modules');
  console.log(`装配 → ${site}：${SHIPPED_FILES.length} 个文件 + ${SHIPPED_DIRS.length} 个目录；仓里 ${strays.length} 项不进产物（${strays.join(', ')}）`);
}

if (!fs.existsSync(site)) {
  console.error(`产物目录不存在：${site}`);
  process.exit(2);
}

const refs = new Set();
const meta = new Map();
const add = (r, from) => {
  if (!r || /^(https?:|data:|blob:|mailto:|#|\/\/)/.test(r)) return;
  const clean = r.split('?')[0].split('#')[0];
  // '.' / './' / '' 指的是产物根（start_url 与 sw 的 SHELL_KEYS 都这么写），它不是一个文件引用。
  if (!clean || /^\.{0,2}\/?$/.test(clean) || clean.endsWith('/')) return;
  refs.add(clean);
  meta.set(clean, (meta.get(clean) || []).concat(from));
};

const readOpt = (f) => (fs.existsSync(f) && fs.statSync(f).isFile() ? fs.readFileSync(f, 'utf8') : null);

const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href|src|content)="([^"]+)"/g)) {
  if (/\.(png|jpe?g|gif|webp|svg|ico|css|js|webmanifest|json)$/i.test(m[1])) add(m[1], 'index.html');
}
for (const m of html.matchAll(/<link[^>]+rel="manifest"[^>]+href="([^"]+)"/g)) add(m[1], 'index.html:manifest');

// 社交标签必须是绝对 URL（爬虫不接受相对路径），而 add() 见 `https?:` 就跳过 —— 于是 og-card
// 那 388KB 会从自检的账上消失，产物里少一张卡也没人报。这里把本站部署域认下来：
//   1. og:url 必须逐字等于它 —— 从兄弟仓拷来的绝对域会在这一条上露头；
//   2. 以它开头的 og:image / twitter:image 折回相对路径，重新受"盘上必须有真的字节"约束。
// 部署域改名时这一行与 index.html 的标签要一起改，改漏一边就是 exit 1。
const SITE = 'https://z-biz-game.github.io/z-biz-game-euclid-cos/';
const ogIssues = [];
const pageUrl = (html.match(/property="og:url"\s+content="([^"]+)"/) || [])[1];
if (pageUrl !== SITE) {
  ogIssues.push(`og:url=${JSON.stringify(pageUrl)} 与部署域 ${SITE} 不一致（缺标签也算）`);
}
for (const m of html.matchAll(/content="(https?:\/\/[^"]+)"/g)) {
  if (m[1].startsWith(SITE) && m[1].length > SITE.length) add(m[1].slice(SITE.length), 'index.html:social');
}

const cssSrc = readOpt(path.join(site, 'css/game.css')) || '';
for (const m of String(cssSrc).matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(path.normalize(path.join('css', m[1])), 'game.css');

const manifestSrc = readOpt(path.join(site, 'manifest.webmanifest'));
let manifest = { icons: [] };
if (manifestSrc === null) {
  add('manifest.webmanifest', 'index.html:manifest');
  console.error('  产物里没有 manifest.webmanifest ⇒ 按"缺一个清单"记账，不猜它的内容');
} else {
  manifest = JSON.parse(manifestSrc);
}
for (const icon of manifest.icons || []) add(icon.src, `manifest:${icon.sizes || '?'}`);
if (manifest.start_url) add(manifest.start_url, 'manifest:start_url');

// sw.js 的预取表是字符串数组，读不到就只查它自己存在 —— 它的注册路径由 js/pwa.js 按模块 URL 解析。
const swSrc = readOpt(path.join(site, 'sw.js'));
if (swSrc === null) add('sw.js', 'js/pwa.js:register');
for (const m of String(swSrc || '').matchAll(/['"]([^'"]+\.(?:html|js|css|png|webmanifest))['"]/g)) add(m[1], 'sw.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(file) {
  const head = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 24, 0); } finally { fs.closeSync(fd); }
  if (!head.slice(0, 8).equals(PNG)) return null;
  if (head.slice(12, 16).toString('ascii') !== 'IHDR') return null;
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
}

// og:image:width/height 是宣称值：拿部署产物里那张 PNG 的 IHDR 实测对一遍，小图冒充 1200×630
// 要在这一条上露头。（放在 pngSize 之后：PNG 是 const，早一步取用会撞 TDZ。）
{
  const img = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1];
  const w = Number((html.match(/property="og:image:width"\s+content="(\d+)"/) || [])[1]);
  const h = Number((html.match(/property="og:image:height"\s+content="(\d+)"/) || [])[1]);
  if (img && img.startsWith(SITE)) {
    const rel = img.slice(SITE.length);
    const dims = fs.existsSync(path.join(site, rel)) ? pngSize(path.join(site, rel)) : null;
    if (!dims) ogIssues.push(`og:image 指向的 ${rel} 不是一张能读 IHDR 的 PNG`);
    else if (dims.w !== w || dims.h !== h) ogIssues.push(`og:image 宣称 ${w}×${h}，IHDR 实测 ${dims.w}×${dims.h}`);
  } else if (img) {
    ogIssues.push(`og:image 不是部署域下的绝对 URL：${JSON.stringify(img)}`);
  } else {
    ogIssues.push('页面没有 og:image 标签');
  }
}

const missing = [];
const empty = [];
const notBitmap = [];
const wrongSize = [];
let checked = 0;
for (const r of [...refs].sort()) {
  const p = path.join(site, r);
  checked++;
  if (!fs.existsSync(p)) { missing.push(r); continue; }
  const st = fs.statSync(p);
  if (st.isDirectory() || st.size === 0) { empty.push(r); continue; }
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(r)) {
    const dims = pngSize(p);
    if (!dims) { notBitmap.push(`${r}（不是 PNG，file magic 不认）`); continue; }
    const declared = (meta.get(r) || []).filter((s) => s.startsWith('manifest:'));
    for (const d of declared) {
      const want = /(\d+)x(\d+)/.exec(d);
      if (want && (Number(want[1]) !== dims.w || Number(want[2]) !== dims.h)) {
        wrongSize.push(`${r} 声明 ${want[1]}×${want[2]}，IHDR 实测 ${dims.w}×${dims.h}`);
      }
    }
  }
}

const forbidden = ['server.cjs', 'tools', 'test', 'electron', 'package.json', 'DESIGN.md', 'README.md', 'deliverable.md', 'assets']
  .filter((p) => fs.existsSync(path.join(site, p)));

console.log(`产物 ${site}`);
console.log(`  引用 ${checked} 条：缺 ${missing.length}、空 ${empty.length}、非位图 ${notBitmap.length}、尺寸不符 ${wrongSize.length}、og 不合格 ${ogIssues.length}`);
console.log(`  manifest：name=${manifest.short_name || manifest.name} icons=${(manifest.icons || []).length} display=${manifest.display} theme_color=${manifest.theme_color}`);
for (const r of missing) console.error('  MISS ' + r + '  ← ' + (meta.get(r) || []).join(','));
for (const r of empty) console.error('  EMPTY ' + r);
for (const r of notBitmap) console.error('  NOT-BITMAP ' + r);
for (const r of wrongSize) console.error('  WRONG-SIZE ' + r);
for (const r of ogIssues) console.error('  OG-FAIL ' + r);
if (forbidden.length) console.error('  LEAK ' + forbidden.join(', ') + '（这些只该留在仓里）');

const bad = missing.length + empty.length + notBitmap.length + wrongSize.length + forbidden.length + ogIssues.length;
if (bad) { console.error(`产物自检：${bad} 项不合格`); process.exit(1); }
console.log('产物自检：通过 —— 每一条引用都在盘上有真的字节。');
