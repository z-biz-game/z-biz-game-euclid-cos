# 交付说明 · 割金 EUCLID

## 1. 功能 → 文件

| 功能 | 文件 | 说明 |
|---|---|---|
| 规则与合法性（`k ∈ 1..⌊a/b⌋`、后继、正好铺满、`moveReason` 一句话拒绝理由、`squareCount = Σ 部分商`、连分数） | `js/core/euclid.js` | 无 DOM、无浮点判定 |
| φ 整数判据 `a²−ab−b²`、唯一胜口、`depth = cfLength + slowSteps`、`reconcile` | `js/core/golden.js` | 路线 2 |
| 自底向上穷举格 `table(bound)` + 记忆化 `solve(a,b)` | `js/core/retro.js` | 路线 1 的两个独立实现 |
| 棋书解码/查询/重算（`decodeBook` 的 11 类拒绝、`lookup` 越界抛 `MissError`、`recomputeBook`、`encodeBook`） | `js/core/book.js` | 页面的唯一判定来源 |
| 对局状态机（口数、两手一组的撤销、`cutFootprint`、`hintAt`、`playToTable`、90° 旋转文案） | `js/core/game.js` | 每个手势一个快照 |
| 题池：档位/带、`derive`、`verifyLot`、`verifyPool`、`campaign` 排序、`dailyLot`、`randomLot`、`poolStats` | `js/core/library.js` | 全部走表查询，不搜索 |
| 烘焙侧的候选枚举、合格闸门、策展 | `js/core/make.js` | 被 `test/library.test.mjs` 直接复算 |
| 种子 RNG 与日历算术（`hashSeed`、`mulberry32`、`shiftDay`、`dayDistance`、`todayKey`） | `js/core/rng.js` | 连击靠它，不靠时间戳差 |
| 存档（单键 `euclid.save.v1`、`best` 只降 / `unlocked` 只升、日胜粘住、`requireBackend` 抛异常探针、坏 JSON 重塑） | `js/core/storage.js` | `js/core` 里唯一允许碰 `window` 的模块 |
| 发货数据：1830 行棋书 + 32 张题卡 + 每日序列 + 档位普查元数据 + `BAKED_AT` | `js/data/lots.js` | 由 `tools/bake.mjs` 生成，39.5 kB |
| 重烘焙与全部 census 打印 | `tools/bake.mjs` | 确定性（除 `BAKED_AT` 行） |
| 画布、几何、手势坐标契约、φ·b 参考线、调色板 | `js/view.js` | 只画像素，不下判断 |
| 页面壳：路由 `#/c #/lot #/daily #/random`、读数面板、证明抽屉、k 按钮、toast、总账、`window.euclid` 钩子 | `js/main.js` + `index.html` + `css/game.css` | 判定一律查表 |
| 零依赖静态服务器（同 CJS 模块，Electron 复用） | `server.cjs` | `npm run dev` → 5221 |
| 桌面壳 | `electron/main.cjs` | 起同一个 `server.cjs` |
| 手写测试框架（`test()` 一行一断言、`rows: N fail: M`） | `tools/harness.mjs` | 无 runner 依赖 |
| 手算 fixture 与三条被推翻的 folklore | `test/fixture.mjs` | 期望值先写在纸上 |
| 朴素极大极小第三方对照（只在小子三角上跑得动） | `test/naive.mjs` | 被 `test/retro.test.mjs` 用 |
| 8 个 node 套件 | `test/{euclid,golden,retro,book,game,library,storage,bake}.test.mjs` | 见 §2 |
| CDP 浏览器驱动 + 5 个场景（含真鼠标、真重载、真窄屏、像素探针） | `tools/playtest.mjs` | 零依赖，用 Node 的全局 `WebSocket`/`fetch` |
| 一键验收门禁（端口预检 → 起服务 → 起 Chrome → 跑套件 → 收尸） | `tools/verify.sh` | 退出码 6/7/8 分别对应 CDP 被占 / WEB 被占 / 有孤儿 Chrome |
| CI 与 Pages | `.github/workflows/{ci,pages}.yml` | 三个 job；Pages 只拷 `index.html`+`css`+`js` |
| 文档 | `README.md`、`DESIGN.md`、`deliverable.md` | 数字全部来自 bake 或测试输出 |

## 2. 验收口径（每条都在这台机器上真跑过）

```bash
npm run check     # 逐文件 node --check → OK
npm run unit      # 8 套件 172 行断言 · 0 失败
node tools/bake.mjs   # 两次，cmp（只归一化 BAKED_AT 行）→ 逐字节相同，且日志除计时外相同
bash tools/verify.sh  # 5 场景 131 行断言 · 0 失败 · console 干净（只有一行 euclid v1 ready · 分歧 0）
```

* **node 套件断言行数**：euclid 25 / golden 13 / retro 16 / book 34 / game 29 / library 25 / storage 17 / bake 13 = **172**，`rows: N fail: 0` 逐套件打印。
* **浏览器场景**：`@boot 20 · @play 29 · @routes 21 · @save 16 · @pointer 45` = **131**。`@pointer` 走 CDP `Input.dispatchMouseEvent`（点 k 按钮、点画布、拖出边界、盘外坐标）、`Page.navigate` 真重载验存档、`Emulation.setDeviceMetricsOverride` 验 360×720、并直接读 canvas 像素。
* **必须失败的东西也测了**：越界查表抛 `MissError`（`拒绝现场搜索`）、`k=0`/`k>x`/非整数/错座位/终局后的输入各回一句话且局面不动、坏 JSON 存档、未知题号、陌生档位、没有可撤的撤销。
* **端口**：本仓固定 `WEB_PORT 5221 / CDP_PORT 9371`（`tools/verify.sh` 头部列出七个邻居的分配）。预检用 `lsof` 两个端口 + `pgrep -fl remote-debugging-port`，被占就退出码 6/7/8，等兄弟 agent 跑完再重试。
* **确定性**：`tools/bake.mjs` 无 `Math.random`、无计时依赖。`test/bake.test.mjs` 跑两遍烘焙（`PHI_CENSUS_MAXA=60`）、核对 `cmp` 相同（除 `BAKED_AT` 行）与 stdout 的 `wrote 32 lots`，再在进程内重算它打印的证据：`1161/669`、`maxDepth 8 且 17 个并列`、`reconcile 无问题`、逐格两路一致、`insertionExamples === 961`（于是 869 格帕==除法数）、唯一胜口 `44850 对 / 0 违例`、`phiCensus(200) === 20100 对 / 0 分歧`、Lamé `n=1..9` 对上 Fibonacci。默认的 `720600 对` 全量复核是 `node tools/bake.mjs` 自己那一步（4.08s）。
* **CI 不装依赖**：`ci.yml` 只用 `checkout` + `setup-node`，Pages 是文件拷贝并有 `test ! -e _site/server.cjs` 之类的自证。

## 3. 未做 / 已知边界

* 不做边界外现算：`a > 60` 的局面页面直接抛。想要更大矩形就得重烘焙：题量 `PER_BAND`、φ 复核上限 `PHI_CENSUS_MAXA`（默认 1200 = 720_600 对）、唯一性普查上限 `UNIQUE_CENSUS_MAXA` 都是 `tools/bake.mjs` 的环境变量，而棋书边界本身 `BOOK_BOUND` 是 `js/core/make.js` 里的常量。
* 不做后手题：题池只出先手必胜（`eligibility` 要求 `value === 'win'` 且 `q ≥ 2`、`帕 ≥ 3`）。必败方视角只在证明抽屉的线路里出现。
* 不做动图/音效/图片/字体资源，不做 i18n（中文文案硬编码），不做云同步、排行、成就。
* 不做手机专属排版：只保证 360px 宽不横向溢出、画布按 dpr 放大、k 按钮与读数面板仍可渲染（`@pointer` 断言）。
* 不做"每步都算"的开放棋盘：这仓的定位就是**表驱动**，任何现场搜索都视为回归。
* 未修的历史遗留：`js/core/euclid.js:164`、`js/core/golden.js:6`、`test/euclid.test.mjs:197`、`test/euclid.test.mjs:280` 四处注释仍指向不存在的 `test/anchor.test.mjs`（恒等式的实际断言位置见 `DESIGN.md` §9.12）。
* 两处**已修**的引擎/视图缺陷见 `DESIGN.md` §9.5、§9.6（90° 旋转标签贴反、`last.blocks` 不可迭代导致第一次渲染即抛）。
