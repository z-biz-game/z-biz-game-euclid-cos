# 设计说明 · 割金 EUCLID

 numbered sections；每一条数字都注明它是"跑出来的"还是"推出来的"。凡是本文件与代码不一致的地方，以代码为准（第 9 节记录了已经发现的分歧）。

## 1. 规则与状态

* 状态是整数对 `(a, b)`，`a ≥ b ≥ 1`。一手选 `k ∈ 1..⌊a/b⌋`，留下 `(max(b, a−kb), min(b, a−kb))`。
* `k = q` 且 `a = q·b` 时金条被**正好铺满**，走这手的人当场获胜——没有"对手无子可走"这种状态。所以终局仍是一个合法的 `(a,b)` 图形，视图照样能画（`js/core/game.js` 的 `finish()` 不改 `a/b`）。
* 一层一层分开：`euclid.js` 只回答"这一手合法吗、后是什么"，`book.js`/`golden.js`/`retro.js` 回答"谁赢、几步赢"，`game.js` 记口数与文案，`view.js` 只画像素，`main.js` 只做路由与 DOM。谁都不许跨层下判断。

## 2. 数学：φ 判据、两条定理、和一个"帕"

**判据（整数，不用浮点）**：`a > b` 时，走的人必败 ⟺ `1 < a/b < φ` ⟺ `a² − ab − b² < 0`。
`a == b` 是唯一的例外：`margin = −b² < 0` 却是胜局（一块切完就铺满）。`js/core/golden.js` 因此**先判 `a > b` 再读符号**，`test/fixture.mjs` 的头四行把这件事写在纸上。

**定理 A**：黄金带里 `q = 1`，必败方只有一个合法 `k`。推论：必败局里"拖延"和"挣扎"是同一手棋，棋书对负局存的 `k` 就是那唯一的一手。
**定理 B**：必胜局的胜口唯一（`(k, k−1)` 阶梯论证）。推论：完美对局是一条被强制的线，随机乱切的猜中率精确等于 `1/q`——页面上的"猜中率"不是修辞。
**定理 C（测量而非 folklore）**：`帕 = 连分数长度 + 插入数`。插入 = 胜口取 `q−1` 而不是 `q`，于是一次除法被拆成两手走。canonical 反例 `7×3`：`cf = 2`，`帕 = 3`。`tools/bake.mjs` 每次烘焙都重数一遍：`positions where plies != divisions 961/1830`（也就是说一半以上的局面 folklore 是错的）。

Lamé 仍成立但换了命题：`n` 次除法所需的最短边是 `(F(n+2), F(n+1))`，`n=1..9` 实测 `(2:1)…(89:55)`，`all == (F(n+2),F(n+1)): true`。而"上限内最长对局一定落在 Fibonacci 对"是**错的**：`a ≤ 20` 时帕最大 6 取在 `(17,12)/(18,13)/(19,12)`，`(13,8)` 只有 5。

## 3. 两条独立路线

| 路线 | 文件 | 做法 |
|---|---|---|
| 1a | `js/core/retro.js` `table(bound)` | 自底向上穷举：三角内每个 `(a,b)` 按 `a` 升序解出，后继必已就位 |
| 1b | `js/core/retro.js` `solve(a,b)` | 记忆化递归，独立实现 |
| 2 | `js/core/golden.js` | 整数 φ 代数 + 连分数（`cfLength`、`slowSteps`） |

烘焙时三方逐状态对齐（1a vs 1b vs 2），产出上面那三行 census；页面启动时再跑一次 `phiReconcile(60)` + 全格扫描，把分歧数印在证明抽屉里（`分歧 0`；若非 0，`main.js` 会 toast 出"别信这页"）。

`test/retro.test.mjs` 另用一个朴素极大极小（`test/naive.mjs`，只在一小块三角上跑得动）作第三方对照，`test/book.test.mjs` 再把解码后的表与三条恒等式逐行核。

## 4. 棋书格式与解码校验

```
BOOK = { bound: 60, states: 1830, win: 1161, loss: 669, rows: ["1:1:win/1/1", … , "60:60:win/1/1"] }
行格式  "<a>:<b>:<value>/<k>/<depth>"
```
`decodeBook()` 的拒绝清单（`test/book.test.mjs` 34 行断言里一大半在演这个）：行数 ≠ `bound(bound+1)/2`、声明的 win/loss 与实际不符、重复行、缺口、键没约分、越界、`k` 非法、`depth` 与后继差 1 不成立、"印着铺满却没切到尽头"、必败局却有多个选择、胜局的后继不是必败。
`lookup()` 越界抛 `MissError`，消息包含"拒绝现场搜索"——这条是产品决定：**页面宁可说"这格不在书里"，也不给你一个新的、没被复核过的判定**。

## 5. 题池是怎么生成的（bake 自己招的内容）

`js/core/make.js`：`candidates(band)` 枚举带内所有互质 `(a,b)`；`eligibility()` 逐条过闸（顺序即代码顺序）：`invalid → no-analysis → outside-book → outside-band → square → not-coprime → loss → fewChoices(q<2) → shallow(帕<3)`；`curate()` 在合格者里按难度取每带 8 关。四个带 `2–14 / 15–22 / 23–34 / 35–60` 各 8 关 = 32 关。

合格率随带升高而**升**（候选更"胖"），发货率随带骤降（**0.7%** 的候选能进大铸，因为要挑得开、又不能撞形状）：

```
nugget:   candidates 91  · eligible 19 (20.9%) · shipped 8 (8.8%)  · reject {shallow:13, loss:24, not-coprime:28, fewChoices:7}   · q 2-6  · 帕 3-5 · margin 11-145
vein:     candidates 140 · eligible 35 (25%)   · shipped 8 (5.7%)  · reject {shallow:8, loss:33, not-coprime:54, fewChoices:10}    · q 2-10 · 帕 3-5 · margin 71-409
crucible: candidates 330 · eligible 93 (28.2%) · shipped 8 (2.4%)  · reject {shallow:12, loss:79, not-coprime:120, fewChoices:26}  · q 2-16 · 帕 3-7 · margin 155-1045
master:   candidates 1209· eligible 345 (28.5%)· shipped 8 (0.7%)  · reject {shallow:26, loss:284, not-coprime:467, fewChoices:87} · q 2-29 · 帕 3-7 · margin 341-3359
campaign deepest: 29×12 帕7 (k=1, q=2) · book deepest: 帕8 at 41:29 (17 positions)
```

战役排序是量出来的，不是编号：`campaign()` 按 `(档位, 帕↑, q↑, a↑, b↑)` 排，所以 `#/c/1` 是 `nugget-06 8×3`（帕 3、q 2），而 `nugget-01 12×5` 排在第 8 关。id 是烘焙时的题卡序号，**不是**难度名次——`@pointer` 因此点名 `#/lot/nugget-01` 而不写 `#/c/1`。

## 6. 点击路径成本表（真实战役 32 关）

`clicks = ⌈帕/2⌋`：你和完美对手轮流，你先切。`帕` 是棋书印的数，`q` 是你每口要分辨的 choices 数（猜中率 `1/q`）。

| # | id | 档位 | 金条 | 胜口 | q | 帕 | 点击 | 猜中率 | 总方金 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | nugget-06 | nugget | 8×3 | k=2 | 2 | 3 | 2 | 50.0% | 5 |
| 2 | nugget-07 | nugget | 11×4 | k=2 | 2 | 3 | 2 | 50.0% | 6 |
| 3 | nugget-08 | nugget | 14×5 | k=2 | 2 | 3 | 2 | 50.0% | 7 |
| 4 | nugget-04 | nugget | 10×3 | k=2 | 3 | 3 | 2 | 33.3% | 6 |
| 5 | nugget-05 | nugget | 13×4 | k=2 | 3 | 3 | 2 | 33.3% | 7 |
| 6 | nugget-03 | nugget | 13×3 | k=3 | 4 | 3 | 2 | 25.0% | 7 |
| 7 | nugget-02 | nugget | 11×2 | k=4 | 5 | 3 | 2 | 20.0% | 7 |
| 8 | nugget-01 | nugget | 12×5 | k=1 | 2 | 5 | 3 | 50.0% | 6 |
| 9 | vein-07 | vein | 15×7 | k=1 | 2 | 3 | 2 | 50.0% | 9 |
| 10 | vein-08 | vein | 21×10 | k=1 | 2 | 3 | 2 | 50.0% | 12 |
| 11 | vein-06 | vein | 15×4 | k=3 | 3 | 3 | 2 | 33.3% | 7 |
| 12 | vein-05 | vein | 17×3 | k=5 | 5 | 3 | 2 | 20.0% | 8 |
| 13 | vein-04 | vein | 22×3 | k=6 | 7 | 3 | 2 | 14.3% | 10 |
| 14 | vein-02 | vein | 18×7 | k=1 | 2 | 5 | 3 | 50.0% | 7 |
| 15 | vein-03 | vein | 22×9 | k=1 | 2 | 5 | 3 | 50.0% | 8 |
| 16 | vein-01 | vein | 22×5 | k=3 | 4 | 5 | 3 | 25.0% | 8 |
| 17 | crucible-08 | crucible | 33×16 | k=1 | 2 | 3 | 2 | 50.0% | 18 |
| 18 | crucible-07 | crucible | 28×9 | k=2 | 3 | 3 | 2 | 33.3% | 12 |
| 19 | crucible-06 | crucible | 23×4 | k=5 | 5 | 3 | 2 | 20.0% | 9 |
| 20 | crucible-05 | crucible | 32×3 | k=10 | 10 | 3 | 2 | 10.0% | 13 |
| 21 | crucible-03 | crucible | 24×11 | k=1 | 2 | 5 | 3 | 50.0% | 9 |
| 22 | crucible-04 | crucible | 31×14 | k=1 | 2 | 5 | 3 | 50.0% | 9 |
| 23 | crucible-02 | crucible | 23×7 | k=2 | 3 | 5 | 3 | 33.3% | 8 |
| 24 | crucible-01 | crucible | 29×12 | k=1 | 2 | 7 | 4 | 50.0% | 8 |
| 25 | master-08 | master | 59×29 | k=1 | 2 | 3 | 2 | 50.0% | 31 |
| 26 | master-07 | master | 56×11 | k=4 | 5 | 3 | 2 | 20.0% | 16 |
| 27 | master-06 | master | 53×4 | k=12 | 13 | 3 | 2 | 7.7% | 17 |
| 28 | master-05 | master | 53×24 | k=1 | 2 | 5 | 3 | 50.0% | 11 |
| 29 | master-04 | master | 60×17 | k=2 | 3 | 5 | 3 | 33.3% | 13 |
| 30 | master-03 | master | 47×11 | k=3 | 4 | 5 | 3 | 25.0% | 10 |
| 31 | master-02 | master | 53×5 | k=9 | 10 | 5 | 3 | 10.0% | 14 |
| 32 | master-01 | master | 53×12 | k=3 | 4 | 7 | 4 | 25.0% | 10 |

分档合计：nugget 17 次点击 / 26 口，vein 19 / 30，crucible 21 / 34，master 22 / 36 —— **整场战役 79 次点击、126 口**。注意帕与 q 是两条独立旋钮：第 20 关 `32×3` 只有 2 次点击却有 10 个选择（10% 猜中率），第 24 关 `29×12` 猜中率 50% 但要在黄金带两侧走满 7 口。把难度做成一维（"更大就更难"）在这张表面前是站不住的。

## 7. 视图与输入契约

* `view.js` 的 cell 由**开局尺寸** `root = [a₀,b₀]` 算出（`layout()`），中途不重算：切短是在一张稳定的网格里缩，不会在手指下滑走。`MAX_CELL 46`、`MIN_CELL 4`、`GAP 2`、`PAD 18`。
* `cutPoint(k)` / `barPoint(col)` 返回**客户端坐标**（含 canvas rect），正是 CDP `Input.dispatchMouseEvent` 要的；`colAt` 是它的逆。这两者若差一个 canvas 偏移，浏览器套件就会点在空中——`@pointer` 存在的唯一理由。
* 招牌视觉是 `x = φ·b` 那条虚线：**判定就是"条头有没有越过线"**。它是全仓唯一读浮点的地方（`PHI_NUM/PHI_DEN = 1346269/832040`，φ 的相邻 Fibonacci 近似，误差 ~4e−13，远小于一个像素），而文字旁边印的是整数 `margin`。
* 像素断言在 `@pointer` 里：金色方格中心计数 `== a×b`、第 `a` 列是托盘（切掉的格子真的不画了）、`a·cell+(a−1)·gap` 的像素跨度、虚线所在竖列的墨色计数远大于对照列、悬停把要切的那几块压暗、360×720 的窄屏里画布按 dpr 放大且不横向溢出。像素读的是**另一个 canvas**（`willReadFrequently: true`），免得 Chrome 对游戏自己的 2D 上下文报渲染 warning——脏 console 在本仓算失败。

## 8. 存档与路由

* 一个键：`euclid.save.v1`，顶层四样 `{records, daily, unlocked, stats}`。`best` 只降、`unlocked` 只升、日胜粘住不回退。
* 连击是**日历算术**（`rng.js shiftDay` + `dayDistance`），不是时间戳相减：25 小时的间隔不该断，23 小时的不该送。今天没打不断连续（从昨天往回数）。
* 读回来的 JSON 一律重塑：坏 JSON → 空白；`unlocked:"many"` → 1；日键不合 `YYYY-MM-DD` 的直接丢（它是连击的输入，留着会静默毁掉整条回退）。写不进去（quota / 隐私窗）就退成内存会话，但 `state.persist` 会说真话——`requireBackend()` 是抛异常的探针，因为它要能区分"没东西"和"被拒绝"。
* 路由：`#/c/<n>`、`#/lot/<id>`、`#/daily`、`#/random/<tier>/<seed>`；越界钳位、未知 id 退回战役、光秃秃的 `#/random` 会把种子写回 URL（可分享）。每日题以日期字符串为种子，所以同一天所有设备同一根金条——`@routes` 用三个固定日期（`2024-02-29`、`2026-01-01`、`2026-12-31`）在页内直接调 `dailyLot` 证它是纯函数。

## 9. 踩过的坑（都还有代码或测试在场）

1. **`帕 == 除法数` 是错的**（见第 2 节）。1830 个局面里 961 个不符。写文档时最容易顺手把"欧几里得算法的步数"当成帕。
2. **`a == b` 破坏 φ 判据的符号**：`margin = −b² < 0` 却是胜局。判据必须先约出 `a > b`。
3. **"胜口判据 `1 < (a−kb)/b < φ`" 是错的**：`k = q` 的后继是 `(b, r)` 而不是 `(a−kb, b)`。`11×4` 的 `k=2` 按错判据会被丢掉，而它正是唯一胜口（后继 `4×3` 必败）。
4. **"最长对局一定在 Fibonacci 对上"是错的**：插入打破了最优性。
5. **90° 旋转标签曾经贴反**：`game.js` 用 `next[0] !== state.b` 判断"长条转了 90°"，于是 `12×5` 直切 `k=1` 剩 `7×5` 也被说成转了（而真正转了的 `k=2 → 2×5 → 归一化 5×2` 没被标出来）。现在是 `hasTurned(b, next) = next[0] === b && next[1] !== b`：只有余下那条比被切方块还窄时才转。`test/game.test.mjs` 把这条文案钉住。
6. **第一口切下去就白屏**：`view.js` 画"上一手切掉的块"时写 `for (const blk of last.blocks)`，而 `history[i].blocks` 是 `cutBlocks()` 的**结果对象** `{blocks, leftover, side}` —— 不可迭代。每次 `render()` 都抛，点第一口就没反应。改成 `last.blocks.blocks`，`@pointer`/win-shot 复现路径。
7. **`autoWin()` 不推进解锁前沿**：`store.unlock()` 只写在 `settle()`（真点击）里，演示按钮 `照表收局` 会写通关纪录但不 `unlock`。这是有意的分层（演示不是通关），但很容易写反，`@save` 现在两个方向都断言。
8. **`#/c/1` 不是 `nugget-01`**（第 5 节）。任何手算像素/帕数的场景都得点名 id。
9. **烘焙"逐字节相同"要减去 `BAKED_AT` 行**：`tools/bake.mjs` 自己就写了这件事。CI 的确定性检查与 `test/bake.test.mjs` 都按"归一化那一行后 `cmp`"来做。
10. **数花括号切 JSON 会被字符串里的花括号骗**：`@save` 故意把 `'{oops'` 这种坏存档当证据打印出来，朴素扫描器于是永远找不到 JSON 结尾。`verify.sh` 的花括号计数器现在走字符串字面量（含转义）。
11. **`document.getElementById('x').hidden` 与 `aria-hidden` 不等价**，`ks` 在终局是 `hidden` + 清空 innerHTML 两件事一起做，断言只查一个会漏。
12. 四处**陈旧注释**指向 `test/anchor.test.mjs`，而那个文件在本仓不存在（前任 agent 留下的引用）：`js/core/euclid.js:164`、`js/core/golden.js:6`、`test/euclid.test.mjs:197`、`test/euclid.test.mjs:280`。这些恒等式现在实际由 `test/euclid.test.mjs`、`test/golden.test.mjs` 与 `test/bake.test.mjs` 断言；`golden.js:6` 引的 `DESIGN §2` 就是本文件第 2 节。

## 10. 已知不做 / 边界

* 棋书边界 `a ≤ 60`：越界只抛 `MissError`，不在页面里现算（连"更大矩形"的每日题都不生成，题池就是那 32 张卡）。
* 只有先手必胜的题（`eligibility` 要求 `value === 'win'`）：必败题作为"对手视角"存在于证明抽屉的线路里，但没有"你后手打一关"的模式。
* 无图像/字体/音频资源，无国际化（文案硬编码中文），无成就/排行/云端同步，无触屏手势以外的输入（拖拽、点按、数字键 1–9、方向键预览 + Enter）。
* Electron 壳只是壳：`electron/main.cjs` 起同一个 `server.cjs`。
* 移动端只保证 360px 宽可用（`@pointer` 的窄屏场景），没有做平板专属排版。

## 11. 复现

```bash
node --check <每个文件>            # npm run check
for f in test/*.test.mjs; do node "$f"; done   # npm run unit
node tools/bake.mjs                # 上面第 3、5 节的每一行都出自这里，重跑两次 cmp 相同
bash tools/verify.sh               # 真实 Chrome：boot/play/routes/save/pointer，端口 5221 + CDP 9371
SKIP_UNIT=1 SCENARIOS=pointer bash tools/verify.sh   # 只跑像素与鼠标
```
