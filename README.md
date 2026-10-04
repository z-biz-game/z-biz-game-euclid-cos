# 割金 · EUCLID

一根 `a×b` 的金条。轮到你时，你从长边上切下 `k` 个 `b×b` 的方块（`1 ≤ k ≤ ⌊a/b⌋`），剩下的金条转个方向继续。**正好铺满**（切完剩 0）的那一手直接获胜。

> **结论先说：轮到你时，只要 `1 < a/b < φ` 你就已经输了**（`φ = (1+√5)/2`）。
> 例外只有一个：`a == b` 是正方形，一块切完就铺满，是胜局 —— 此时 `a² − ab − b² = −b² < 0`，
> 所以判据必须写成"先约出 `a > b`，再看整数符号"。本仓所有代码与文档都按这个顺序写。

于是整个游戏是一台把欧几里得长除法切成方金块的机器；它的"完美对手"不需要思考，只查一张烘焙进页面的表。

---

## 1. 三条定理，和它们在仓库里的证据

| # | 定理 | 证据（跑一遍就能看到） |
|---|---|---|
| A | 落在黄金带里的局面 `q = ⌊a/b⌋ = 1`，也就是**只有一个合法 `k`** —— 必败方没有选择，只有一条路可拖延 | `test/retro.test.mjs`、`test/book.test.mjs`（对全部 669 个负局断言 `q==1 && k==1`）、`tools/bake.mjs` 的 `lossWithChoice 0` |
| B | 必胜局面的**胜口唯一**（`(k, k−1)` 型阶梯论证）—— 所以完美对局是一条被强制的线，随机乱切的猜中率精确等于 `1/q` | `test/golden.test.mjs`、`test/book.test.mjs`，以及 `tools/bake.mjs` 的普查：`uniqueness census 1<=b<a<=300: 44850 pairs · >=2 winning moves 0` |
| C | **帕 ≠ 除法数**：`depth = 欧几里得除法次数 + 插入数`。反例 `7×3`：`7=2·3+1`、`3=3·1` 只有两次除法，帕是 **3**。在 `a ≤ 60` 的 1830 个局面里，有 **961 个** 帕与除法次数不相等 | `test/euclid.test.mjs` / `test/golden.test.mjs` 的恒等式，`tools/bake.mjs` 的 `identities ... depth==cf+slow bad 0 · positions where plies != divisions 961/1830` |

顺带一条被推翻的 folklore：**「上限内最长对局一定落在相邻 Fibonacci 对上」是错的** —— `a ≤ 20` 时帕的最大值 6 取在 `(17,12)`、`(18,13)`、`(19,12)`，而 `(13,8)` 只有 5。`test/fixture.mjs` 的 `FOLKLORE` 把这三条错话连同反例一起钉在仓库里，`test/golden.test.mjs` 逐条断言它们不成立。

Lamé 那一侧仍然成立，只是不再是"最长对局"：`n=1..9` 次除法所需的最短边是 `(2:1) (3:2) (5:3) (8:5) (13:8) (21:13) (34:21) (55:34) (89:55)`，全部等于 `(F(n+2), F(n+1))`（`tools/bake.mjs` 每次烘焙都复算这行）。

## 2. 两条独立路线，逐状态对齐

* **路线 1**：`js/core/retro.js` —— 自底向上的穷举格 `table(bound)` 加记忆化递归 `solve(a,b)`。两条实现互查。
* **路线 2**：`js/core/golden.js` —— 纯整数 φ 代数：`a² < ab + b²` 判负，`winningK` 用取整把唯一胜口算出来，`depth` 用连分数的部分商加插入数算出来。

烘焙前逐局面比对，浏览器里再算一次：

```
route1 grid a<=60: 1830 positions (1161 win / 669 loss) · bottom-up vs memoised disagreements 0 · multiWinning 0 · lossWithChoice 0 · marginZero 0 · maxDepth 8 (17 argmax)
route2 φ vs route1 grid: 1830 positions · structural problems 0 · disagreements 0
two-route sweep 1<=b<=a<=1200: 720600 pairs · agree 720600 · disagree 0
```

页面自己也不信任发货的文件：`window.euclid.recomputeBook()` 在浏览器里把 1830 行**全部重算**并与 `BOOK.rows` 逐行比对（`@boot` 断言 `same && mismatchCount === 0`）。

## 3. 棋书：一张表，越界就抛异常

`js/data/lots.js` 的 `BOOK.rows` 是 1830 行 `"<a>:<b>:<value>/<k>/<depth>"`，覆盖整个三角 `1 ≤ b ≤ a ≤ 60`（`60·61/2 = 1830`）。`js/core/book.js`：

* `decodeBook()` 拒绝：行数与边界不符、重复、缺口、键没约分（`3:7`）、`k` 不合法、`depth` 与后继差 1 不成立、"铺满却没切到尽头"、以及**必败局却有多个选择**（定理 A 的直接检查）。
* `lookup()` 在边界外抛 `MissError`（消息含"拒绝现场搜索"）——**页面上永远不会出现一个现算的判定**。UI 里 `classify('61:7')` 就是抛的（`@play` 断言）。

## 4. 生成普查（`node tools/bake.mjs` 自己印出来的数）

| 档位 | 长边 | 候选 | 合格 | 发货 | 淘汰原因 | q | 帕 | margin |
|---|---|---|---|---|---|---|---|---|
| nugget 碎金 | 2–14 | 91 | 19 (20.9%) | 8 (8.8%) | shallow 13 / loss 24 / not-coprime 28 / fewChoices 7 | 2–6 | 3–5 | 11–145 |
| vein 矿脉 | 15–22 | 140 | 35 (25%) | 8 (5.7%) | shallow 8 / loss 33 / not-coprime 54 / fewChoices 10 | 2–10 | 3–5 | 71–409 |
| crucible 坩埚 | 23–34 | 330 | 93 (28.2%) | 8 (2.4%) | shallow 12 / loss 79 / not-coprime 120 / fewChoices 26 | 2–16 | 3–7 | 155–1045 |
| master 大铸 | 35–60 | 1209 | 345 (28.5%) | 8 (0.7%) | shallow 26 / loss 284 / not-coprime 467 / fewChoices 87 | 2–29 | 3–7 | 341–3359 |

战役最深的一关 `29×12`（帕 7，`k=1`，`q=2`）；棋书全局最深是帕 8，取在 `41:29`（共 17 个并列）。文件 `39.5 kB`。

## 5. 跑起来

```bash
npm run dev        # 静态服务器 http://127.0.0.1:5221/（本仓固定端口）
npm run check      # 逐文件 node --check
npm run unit       # 8 个测试套件，全部走 tools/harness.mjs
npm run bake       # 重算棋书 + 重选题池，写 js/data/lots.js（确定性）
npm run verify     # node 套件 + 真实 headless Chrome 打页面（CDP 9371）
npm run electron   # 桌面壳
```

浏览器门禁要 Chrome（`/Applications/Google Chrome.app/...`），并且**不加** `--use-gl=angle --use-angle=swiftshader`：这游戏是纯 2D canvas，默认 headless 足够，软件光栅化只会把 CPU 吃满并让进程不退出。端口分配写在 `tools/verify.sh` 的头部：本仓 **5221 / 9371**，邻居是 gridlock 5180/9340、tango 5191/9351、hanoi 5192/9352、staircase 5212/9353、chomp 5201/9361、ulam 5222/9372、loshu 5223/9373；被占就等，不削弱检查。

## 6. 屏幕上的每个数从哪来

| 页面上看到的 | 来源（唯一实现） |
|---|---|
| 判定 必胜/必败 | `book.js lookup()` 的 `value` ← 烘焙前由 `retro.js` 与 `golden.js` 各自独立量出并比对 |
| 帕 | `BOOK` 行的 `depth`（`retro.js`） |
| 唯一胜口 k | `BOOK` 行的 `k` |
| q、可切 1–q | `euclid.js quotient(a,b) = ⌊a/b⌋` |
| `a² − ab − b²` | `euclid.js margin(a,b)`（整数，无浮点） |
| 比值 `a/b` 的显示 | `euclid.js ratioText()`——长除逐位，不是 `a/b` 的浮点打印 |
| 猜中率 `1/q` | `library.js derive().chance` |
| 已切/总方金数 | `game.js` 累加 / `euclid.js squareCount = Σ 部分商` |
| φ·b 那条虚线的位置 | `view.js goldenPx()`——**全仓唯一用浮点的地方**，只画线，不参与任何判定 |
| 通关 / 胜 / 负 / 连续天数 | `storage.js totals()` 与 `streak()`（连击走 `rng.js shiftDay` 的日历算术） |
| 32 关题面、每日题 | `js/data/lots.js` 的 `LOTS` / `DAILY_IDS`；`dailyLot(dateKey)` 以日期字符串为种子 |

## 7. 测试与门禁（数量都是跑出来的）

* 8 个 node 套件、**172 行断言、0 失败**：`euclid 25 · golden 13 · retro 16 · book 34 · game 29 · library 25 · storage 17 · bake 13`。期望值来自 `test/fixture.mjs`（先手算在纸上，再写进代码）与 `tools/bake.mjs` 的真实输出。
* `bash tools/verify.sh` 在真实 headless Chrome 里跑 5 个场景、**131 行断言、0 失败**：`@boot 20 · @play 29 · @routes 21 · @save 16 · @pointer 45`。`@pointer` 用 CDP 派发真的鼠标事件、`Emulation.setDeviceMetricsOverride` 装窄屏、`Page.navigate` 真重载，并且直接读 canvas 像素（"金色方格数 == a×b"、`a·cell+(a−1)·gap` 的像素跨度、φ·b 虚线上的墨色计数）。
* 空套件算失败：一个场景报告 0 行断言时 `verify.sh` 直接判负——静默死掉的 harness 看起来最像绿。
* CI：`.github/workflows/ci.yml` 三个 job（node 套件 / 重烘焙确定性 `cmp` + 页面骨架 / headless 浏览器），Pages：`.github/workflows/pages.yml` 调 `bash tools/assemble-site.sh` 拷出 `_site`——「拷哪些」只住在那份清单里，文档不再手抄一遍。**全仓零依赖，任何地方都不需要 `npm install`。**

## 8. 目录

```
index.html  css/  js/{main.js,view.js,core/*.js,data/lots.js}  server.cjs  electron/
tools/{bake.mjs,harness.mjs,playtest.mjs,verify.sh}  test/{fixture.mjs,naive.mjs,*.test.mjs}
```

`js/core/*` 不碰 DOM（除 `storage.js` 里那处被 `requireBackend()` 守住的 `window`），所以 node 能直接 import 规则层；`js/view.js` 只画像素，`js/main.js` 只做路由/渲染/存档，判定一律来自表查询。

MIT。

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`36`）与这一次跑的断言条数（`54`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`36`、断言仍然 `54`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。

