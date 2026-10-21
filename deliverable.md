# deliverable — z-biz-game-kakuro-cos

基线 HEAD `2131bee`（并线后）→ 本次提交 `44314c6`。
所有数字都是本机现跑的输出，命令原样附在第 8 节。

## 0. 一句话

并线把两侧的实现按块拼在一起，拼出四处断点：画布输入被拆成第三种形态（语法错、整仓不可玩）、
全屏写了两份（同名顶层声明、又是语法错）、四组快捷键被弄丢、`index.html` 里留下两颗同 id 的全屏按钮。
本次逐处归因并修掉，**没有删任何功能**：删的全是并线拼出来的重复实现，
而并线弄丢的 M/R/F/?/Enter 四组快捷键与两个全屏入口都补回来了。

## 1. 画布输入被拼成第三种形态（整仓不可玩）

**旧代码错在哪**

并线后的 `bindCanvas` 变成：

```js
el.canvas.addEventListener('pointerdown', (ev) => {
  ...
  const hit = view.hitTest((t.clientX - rect.left) * sx, ...);   // t 从未声明
  ...
};                                                                 // 少了右括号
...
el.canvas.addEventListener('pointerdown', pick);                    // pick 从未声明
```

并线前两侧的 `bindCanvas` **完全一致**：`const pick = (ev) => {...}` 闭包 + 三处 `addEventListener`
（有 Pointer Events 就只走 pointerdown，否则 touchstart + mousedown 回落）。
并线把闭包拆成了「一半内联、一半引用」。

**新代码为什么对**

按并线前那一份恢复 `const pick = (ev) => {...}` 的结构，并保住并线后新增的暂停检查
（落子要跟 `press`/`hint`/`undo` 一样被暂停挡住）。

## 2. `toggleFullscreen` 同名顶层声明（整仓不可玩）

**旧代码错在哪**

并线留下两套全屏实现：

| | ours（较新） | theirs（较旧） |
|---|---|---|
| 状态 | `fullscreenNode()` / `canFullscreen()` / `syncFullscreen()` | `fsRoot()` / `fsElement()` / `fsRequest()` / `fsQuiet()` |
| 开关 | `toggleFullscreen()`（无参） | `toggleFullscreen(root)`（带参）——**同名顶层声明** |
| 接线 | 绑 `el.fsBtn`，回写后还要 `relayout()` + `paint()` | `bindFullscreen(btn)` + `bootFullscreen()` |
| 独有 | 不支持全屏时把按钮 disable 并写「不支持全屏」 | ms 前缀、`title` 回写、F 键、不支持时说明原因 |

ES module 是严格模式，同一作用域里两个同名函数声明直接是 SyntaxError
（`Identifier 'toggleFullscreen' has already been declared`）—— 整份 main.js 一行都不执行。

**新代码为什么对**

以 ours 为主体合成一份，能力取两边并集：

- 补 ms 前缀（`msRequestFullscreen` / `msExitFullscreen`）与 `title` 回写（theirs 侧的能力：
  Esc 或 iOS 手势退出后，按钮文案要拉回正确状态）。
- 删 theirs 那套（`fsRoot`/`fsElement`/`fsRequest`/`fsQuiet`/`bindFullscreen`/`bootFullscreen`
  与第二个 `toggleFullscreen`）—— 同一件事的第二套实现。

## 3. 并线把四组快捷键弄丢了

**旧代码错在哪**

并线前的键位表是：`1-9` 填格 · `Backspace/Delete/0` 清格 · `n` 笔记 · `h` 提示 · `z` 撤销 ·
`c` 检查 · `p` 暂停 · `r` 重开本局（章节页则是开局）· `m` 静音 · `f` 全屏 · `?` 菜单 ·
`空格/Enter`（盘面=暂停，章节页=开局）· 方向键移光标，外加一条保护：
「焦点停在某个按钮上时，空格/回车由浏览器变成那次 click，这里再动一次就是一键两下」。

并线后的键位块只剩 `1-9`/`Backspace`/`n`/`h`/`z`/`c`/`p`/方向键 ——
**`M`、`R`、`F`、`?`、`Enter` 全没了**（静音只剩点按钮那条路，全屏连键盘入口都没了）。

**新代码为什么对**

按并线前的键位表补回那五组键，并把「焦点在按钮上不重复触发」的保护一起补回
（空格现在也绑了暂停，不挡的话在按钮上按空格会「暂停 + 触发按钮」两件事一起发生）。
并线后新增的「暂停锁盘」那层保留：暂停时只有 `p`/`P`/`空格` 能穿过去，其余键一律被挡。

## 4. `index.html` 里两颗同 id 的全屏按钮

**旧代码错在哪**

并线把两侧的 `index.html` 拼在一起，顶栏那颗（theirs 的 HUD 段）与盘面侧那颗（两侧共有）
都叫 `#btn-fullscreen` —— id 重复，`$('#btn-fullscreen')` 只会取到第一颗，
另一颗点了没反应。

**新代码为什么对**

闸要的是顶栏那颗：名册逐字对上 `btn-pause,btn-sound,btn-fullscreen,btn-notes`，
而且它写着 `title="全屏 (F)"`（闸要「title 说了键位 F」）。于是：

- 顶栏那颗保留原样；
- 盘面侧那颗改成 `#btn-fullscreen-2`，并接上同一个 handler；
  `syncFullscreen()` 里它的文案/状态/`title` 同样回写（不能一个变一个不变），
  不支持全屏时也一起置灰。

两个入口都保留，没有重复 id。

## 5. 真实文件清单

| 文件 | 改了什么 |
|---|---|
| `js/main.js` | 恢复 `bindCanvas` 的 `pick` 闭包；全屏合成一份（补 ms 前缀与 `title` 回写，删 theirs 那套）；键位块补回 M/R/F/?/Enter 与焦点保护；`fsBtn2` 接线与状态回写 |
| `index.html` | 顶栏保留 `#btn-fullscreen`，盘面侧那颗改 `#btn-fullscreen-2` |
| `DESIGN.md` | `js/main.js` 行号钉 827 → 909-910 |
| `tools/deploy-set.mjs` | `EXPECT_CHECKS` 37→46、`EXPECT_ROWS` 56→65 |
| `deliverable.md` | 本文件 |

## 6. 删行审计

| 删除 | 为什么能删 |
|---|---|
| `bindCanvas` 里那半截内联 `pointerdown` 处理器 | 它少了右括号、用未声明的 `t`，且与下面引用未声明的 `pick` 的三处 `addEventListener` 是同一件事的两半；按并线前那一份恢复 |
| `fsRoot` / `fsElement` / `fsRequest` / `fsQuiet` | theirs 侧的第二套全屏工具函数；ours 那套（`fullscreenNode`/`canFullscreen`）已覆盖同样职责，能力取并集后这四个没有独立职责 |
| `bindFullscreen` / `bootFullscreen` 及其调用 | 同一件事的第二套接线；ours 侧是 `el.fsBtn.addEventListener('click', ...)`，已把 theirs 的 click/change/F 键三处接线都并进来 |
| 第二个 `toggleFullscreen(root)` | 与 ours 的同名顶层声明，ESM 里直接 SyntaxError；功能并入 ours 那一份 |
| theirs 那段 F 键 `keydown` | 同一个 F 键被绑两次会「一按切两次」；统一由 ours 的键位块处理 |

**并线弄丢的（本次补回，不是删除）**：`M` 静音、`R` 重开本局、`F` 全屏、`?` 菜单、`Enter` 开局，
以及「焦点在按钮上时空格/回车不重复触发」的保护。

## 7. 验收（原样输出）

```
$ npm test --silent
144 通过 / 0 失败        （engine-test）
28 通过 / 0 失败         （docs-test）

$ bash tools/verify.sh
=== first === === play === === hint === === conflict === === win ===
=== resume-a === === resume-b === === resume-c === === resume-d ===
=== dirty-a === === dirty-b === === dirty-c === === touch === === geom === === pause ===
44 checks, 0 failed  {'fs': 'entered', 'focus': True, 'fsEnabled': True, ...}
部署集：46 条引用（含 3 张位图尺寸核对），失败 0 项
rows: 65 fail: 0
DS_SELFTEST rc=0（0=每一刀都按预期发力、阴性对照按预期不发力）
=== ALL GREEN ===
```

## 8. 行为变化需知会

1. **盘面侧那颗全屏按钮的 id 变成 `#btn-fullscreen-2`**：两处入口都还能点（都接同一个 handler），
   但如果有外部脚本按 `#btn-fullscreen` 找盘面侧那颗，会找不到 —— 顶栏那颗的 id 没变。
2. **M/R/F/?/Enter 五个键恢复可用**：静音、重开本局（章节页为开局）、全屏、菜单、开局。
   空格/Enter 在焦点落在按钮上时不重复触发（保护一并补回）。
3. **全屏按钮的 `title` 会随全屏状态回写**（`全屏 (F)` ⇄ `退出全屏 (F)`），
   盘面侧那颗也同步回写。

## 9. 未实现 / 需人接手

- 本仓无未实现项。
- 部署集的期望值（`EXPECT_CHECKS` / `EXPECT_ROWS`）是随页面引用走的数字钉；
  之后若再改 `index.html` 的引用（增删 `<link>`/`<script>`/位图），需重跑
  `node tools/deploy-set.mjs` 并按 `DEPLOY_SET_DUMP=1` 的逐条出处同步这两个数。
