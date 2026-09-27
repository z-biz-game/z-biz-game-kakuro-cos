// 浏览器侧场景套件。由 tools/playtest.cjs 注入到真实页面里跑。
//
// 断言纪律（规范 §1/§6）：读 DOM 几何与画布像素，不读内部标志位。点一格要真的 dispatch
// PointerEvent、落子要真的走键盘/按钮、存档要真的从 localStorage 反解回来比对。
// 每个失败都打"当前值 vs 期望值"，每个通过也带着实测数字（坐标、像素计数、RLE 长度）。
//
// window.kakuro.engine 就是出货的那套引擎（main.js 直接把模块图挂上去），
// 所以这里通过的提示断言，等于玩家按提示走的那条路也通过。
//
// 跨刷新配对：playtest.cjs 每次 scenario 调用都会重新 navigate —— 同一个 Chrome profile、
// 同一块磁盘上的 localStorage。resume-a/dirty-a 写盘后收工，resume-b/dirty-b 在那次
// "真刷新"之后启动，读到的必然是反序列化+清洗过的存档，而不是内存残骸。
// 场景之间的快照走 sessionStorage（测试自己的通道，App 依旧只写一个 localStorage 键）。

((w) => {
  const errors = [];
  w.addEventListener('error', (e) => errors.push(String((e && e.message) || e)));
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String((e && e.reason) || e)));

  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const eq = (test, got, want) => ck(test, String(got) === String(want), `got ${got} / want ${want}`);
  const report = (extra) => {
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const KEY = 'kakuro.save.v1';
  const SNAP = '__kakuroScnSnap';
  const A = () => w.kakuro;
  const E = () => w.kakuro.engine;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const text = (sel) => (($(sel) || {}).textContent || '').trim();
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const shown = (sel) => {
    const e = $(sel);
    if (!e || e.hidden) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  const rgb = (s) => {
    const m = String(s).match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) return [+m[1], +m[2], +m[3]];
    const h = String(s).replace('#', '');
    return h.length >= 6 ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : [-1, -1, -1];
  };
  const near = (p, c, tol = 24) => p.every((v, i) => Math.abs(v - c[i]) <= tol);

  const colors = () => ({
    paper: rgb(cssVar('--paper')),
    ink: rgb(cssVar('--ink')),
    black: rgb(cssVar('--grid-strong')),
    tile: rgb(cssVar('--tile')),
    tileAlt: rgb(cssVar('--tile-alt')),
    runGlow: rgb(cssVar('--run-glow')),
  });

  // 画布取色：layout 给的是 CSS 像素，backing store 是 CSS×dpr。
  function countIn(cssX, cssY, cssW, cssH, target, tol) {
    const v = A().view;
    const d = v.dpr;
    const x = Math.round(cssX * d);
    const y = Math.round(cssY * d);
    const ww = Math.max(1, Math.round(cssW * d));
    const hh = Math.max(1, Math.round(cssH * d));
    const data = v.ctx.getImageData(x, y, ww, hh).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.abs(data[i] - target[0]) <= tol && Math.abs(data[i + 1] - target[1]) <= tol && Math.abs(data[i + 2] - target[2]) <= tol) n++;
    }
    return n;
  }
  const pixel = (cssX, cssY) => {
    const v = A().view;
    const d = v.dpr;
    const q = v.ctx.getImageData(Math.round(cssX * d), Math.round(cssY * d), 1, 1).data;
    return [q[0], q[1], q[2]];
  };

  // ---- 真实输入 ------------------------------------------------------------------------------------

  function pointer(type, x, y) {
    const ev = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }
  const canvasBox = () => A().view.canvas.getBoundingClientRect();
  /** 密集下标 t（白格序号）→ 页面坐标 + 格内矩形。 */
  function atOrdinal(t) {
    const g = A().game.board.cellOf[t];
    const r = A().view.cellRect(g);
    const box = canvasBox();
    return { grid: g, rect: r, x: box.left + r.x + r.size / 2, y: box.top + r.y + r.size / 2 };
  }
  async function tapOrdinal(t) {
    const p = atOrdinal(t);
    pointer('pointerdown', p.x, p.y);
    pointer('pointerup', p.x, p.y);
    await wait(24);
    return p;
  }
  async function tapGrid(grid) {
    const r = A().view.cellRect(grid);
    const box = canvasBox();
    pointer('pointerdown', box.left + r.x + r.size / 2, box.top + r.y + r.size / 2);
    pointer('pointerup', box.left + r.x + r.size / 2, box.top + r.y + r.size / 2);
    await wait(24);
  }
  async function key(k) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    await wait(24);
  }
  async function click(sel) {
    $(sel).click();
    await wait(30);
  }

  const solOf = (id) => {
    const lv = E().LEVELS.find((p) => p.id === id);
    return E().rleDecode(lv.ink, lv.cells);
  };
  const startPuzzle = async (id) => {
    A().store.reset();
    A().start(A().puzzleById(id));
    await A().settled();
    await wait(30);
    return A().game;
  };

  /** 黑格三个探测区：右上（纵向和）、右下（横向和）、左上（永远不该有字）。 */
  const clueQuads = (x, y, s) => {
    const C = colors();
    return {
      upRight: countIn(x + s * 0.5, y + s * 0.08, s * 0.44, s * 0.38, C.paper, 26),
      dnRight: countIn(x + s * 0.5, y + s * 0.58, s * 0.44, s * 0.34, C.paper, 26),
      blankUL: countIn(x + s * 0.08, y + s * 0.08, s * 0.4, s * 0.4, C.paper, 26),
    };
  };
  /** 一个黑格按它带哪些线索应当呈现什么；返回违规原因或 null。 */
  function blackCellSays(board, g) {
    const r = A().view.cellRect(g);
    const q = clueQuads(r.x, r.y, r.size);
    const hasDn = board.down[g] > 0;
    const hasAc = board.across[g] > 0;
    const upOk = hasDn ? q.upRight >= 6 : q.upRight === 0;
    const dnOk = hasAc ? q.dnRight >= 6 : q.dnRight === 0;
    if (upOk && dnOk && q.blankUL === 0) return null;
    return { g, name: E().cellName(board.w, g), dn: board.down[g], ac: board.across[g], ...q };
  }

  // ---- 场景 1：首屏 -------------------------------------------------------------------------------

  const first = async () => {
    eq('页面标题', document.title, '加算十字 · Kakuro 交叉和推理');
    eq('品牌行是加算十字', text('#app h1'), '加算十字');
    ck('window.kakuro 挂出且带版本', typeof A().version === 'string' && /^\d+\.\d+/.test(A().version), typeof A().version);
    ck('引擎跟着挂出（solve/verify/countSolutions）', !!(E().solve && E().verify && E().countSolutions));
    ck('开局前是章节页', shown('#view-menu') && !shown('#view-game'));
    eq('烘焙章节五章', $$('.chapter').length, 5);
    eq('现抽档位五档', $$('.tier').length, 5);
    eq('规则表六条', $$('.rules li').length, 6);

    $('.chapter[data-chapter="0"]').click();
    await wait(80);
    await A().settled();
    const game = A().game;
    ck('点章节进入棋局', shown('#view-game'));
    eq('进的是第一章第 1 局', text('#stat-name'), '第1章 第1局');
    eq('档位名', text('#stat-tier'), '入门');
    eq('尺寸', text('#stat-size'), '5×5');
    ck('首屏（含开局绘制）无未捕获异常', errors.length === 0, errors.join(' | '));

    const cv = $('#board');
    const box = cv.getBoundingClientRect();
    ck('canvas 尺寸非 0', box.width > 100 && box.height > 100, `${box.width}x${box.height}`);
    const L = A().layout();
    eq('backing = css × dpr', Math.round(box.width * L.dpr), L.backingWidth);
    ck('dpr 至少 1', L.dpr >= 1, String(L.dpr));
    eq('画布 CSS 宽 = cell×5+2×PAD', Math.round(box.width), L.cell * 5 + 12);

    // 线索像素：黑格右上=纵向和、右下=横向和，纸色像素落在正确的象限
    const b = game.board;
    let dnCells = 0;
    let acCells = 0;
    let dnLit = 0;
    let acLit = 0;
    const suspects = [];
    let blackCells = 0;
    for (let g = 0; g < b.size; g++) {
      if (!b.black[g]) continue;
      blackCells++;
      const bad = blackCellSays(b, g);
      if (bad) suspects.push(bad);
      if (b.down[g] > 0) {
        dnCells++;
        if (!bad) dnLit++;
      }
      if (b.across[g] > 0) {
        acCells++;
        if (!bad) acLit++;
      }
    }
    eq('写纵向和的黑格都点亮右上', dnLit, dnCells);
    eq('写横向和的黑格都点亮右下', acLit, acCells);
    ck('可疑黑格为 0', suspects.length === 0, JSON.stringify(suspects.slice(0, 3)));
    eq('c0p0 的线索数（读数对拍 619 条 run 的样本局）', b.clues, 10);
    eq('run 数读数', b.runs.length, 10);
    eq('棋盘读数 对上的run', text('#stat-satisfied'), '0/10');
    const lv = E().LEVELS.find((p) => p.id === 'c0p0');
    eq('黑格数对拍编码表', blackCells, Array.from(lv.code.bl).filter((ch) => ch === '1').length);
    return report({ cell: L.cell, dpr: L.dpr, css: `${Math.round(box.width)}x${Math.round(box.height)}`, dnCells, acCells, blackCells });
  };

  // ---- 场景 2：点格 + 键盘落子 + 存档落盘 ----------------------------------------------------------

  const play = async () => {
    const game = await startPuzzle('c0p0');
    const b = game.board;
    const sol = solOf('c0p0');
    const t = 2;
    const digit = sol[t];
    ck('测试格有解可对照', digit >= 1 && digit <= 9, String(digit));

    await tapOrdinal(t);
    eq('点一格后选中它', game.state().selected, t);
    eq('选中格读数（DOM 坐标文本）', text('#stat-cell'), b.name(t));
    eq('开局步数 0', text('#stat-moves'), '0');

    await key(String(digit));
    eq('键盘落子写进棋盘', game.values[t], digit);
    eq('步数 1', text('#stat-moves'), '1');
    eq('已填读数', text('#stat-filled'), '1/9');
    eq('这格读数变成定值', text('#stat-cands'), String(digit));

    // 像素：格中心画出等宽墨色数字
    const C = colors();
    const r = atOrdinal(t).rect;
    const inkPx = countIn(r.x + r.size * 0.3, r.y + r.size * 0.2, r.size * 0.4, r.size * 0.6, C.ink, 60);
    ck('格内有墨色数字像素', inkPx >= 6, `墨色像素 ${inkPx} @${b.name(t)} rect=${Math.round(r.x)},${Math.round(r.y)},${r.size}`);
    const corner = pixel(r.x + r.size * 0.12, r.y + r.size * 0.12);
    ck('同格角落仍是背景（数字没糊满整格）', !near(corner, C.ink, 60), `角落像素 ${corner}`);

    // localStorage：单键、RLE 逐格回读
    const keys = Object.keys(localStorage);
    eq('localStorage 只有一个键', keys.join(','), KEY);
    const raw = JSON.parse(localStorage.getItem(KEY));
    ck('resume 落了盘', !!raw.resume, JSON.stringify(Object.keys(raw)));
    eq('resume.ink 反解 == 棋盘', Array.from(E().rleDecode(raw.resume.ink, b.n)).join(','), Array.from(game.values).join(','));
    eq('resume.moves', raw.resume.moves, 1);
    eq('resume.hints', raw.resume.hints, 0);
    eq('resume 记的是这一局的编码', JSON.stringify(raw.resume.code) === JSON.stringify(A().puzzleById('c0p0').code), true);
    ck('ink 编码比一格一数省', raw.resume.ink.length < b.n * 4, `RLE ${raw.resume.ink.length} 字符 / ${b.n} 格`);

    // 再按同一个数字 = 擦掉
    await key(String(digit));
    eq('重按同数字擦掉这格', game.values[t], 0);
    eq('擦掉也算一步', text('#stat-moves'), '2');

    // 点数字键盘按钮落子（DOM 路径）
    await click(`#keypad .pad-key[data-digit="${digit}"]`);
    eq('点键盘按钮也能落子', game.values[t], digit);
    eq('键盘按钮的 aria-pressed 跟着走', $(`#keypad .pad-key[data-digit="${digit}"]`).getAttribute('aria-pressed'), 'true');
    await click('#btn-erase');
    eq('擦这格按钮清空墨水', game.values[t], 0);
    eq('擦完候选回到初始域', game.notes[t], b.initMask[t]);

    // 铅笔模式
    await click('#btn-mode-note');
    eq('模式切到记铅笔', game.mode, 'note');
    eq('按钮按下态', $('#btn-mode-note').getAttribute('aria-pressed'), 'true');
    const d1 = ((digit % 9) + 1);
    const d2 = ((digit + 3) % 9) + 1;
    const wantMask = (1 << d1) | (1 << d2);
    await click(`#keypad .pad-key[data-digit="${d1}"]`);
    await click(`#keypad .pad-key[data-digit="${d2}"]`);
    eq('铅笔只写候选不写数', game.values[t], 0);
    eq('两个候选位都写上', game.notes[t] & wantMask, wantMask);
    eq('候选读数', text('#stat-cands'), game.candidatesOf(t).join(' '));
    await click('#btn-mode-ink');
    eq('切回写数字', game.mode, 'ink');
    await click('#btn-fill-notes');
    ck('按候选填满铅笔后候选非空', game.notes[t] > 0, String(game.notes[t]));
    ck('引擎候选 ⊆ 初始候选域', (game.notes[t] & ~b.initMask[t]) === 0, `mask=${game.notes[t]} init=${b.initMask[t]}`);

    // 撤销链条：autoNotes 不计步，撤销要先退掉它再退铅笔
    const movesBefore = game.moves;
    await click('#btn-undo');
    eq('撤销退掉候选填满', game.notes[t], wantMask);
    eq('候选填满本身不计步', game.moves, movesBefore);
    await click('#btn-undo');
    eq('再撤一步退掉最后一笔铅笔', game.notes[t], 1 << d1);
    eq('铅笔落子计了步', game.moves, movesBefore - 1);

    // 铅笔显/藏
    await click('#btn-notes');
    eq('铅笔显藏切文案', text('#btn-notes'), '铅笔 藏');
    eq('显藏设置落盘', JSON.parse(localStorage.getItem(KEY)).options.hideNotes, true);
    await click('#btn-notes');
    eq('再点回显', text('#btn-notes'), '铅笔 显');

    const raw2 = JSON.parse(localStorage.getItem(KEY));
    eq('收尾时棋盘与存档仍逐格一致', Array.from(E().rleDecode(raw2.resume.ink, b.n)).join(','), Array.from(game.values).join(','));
    return report({ moves: game.moves, digit, t, cell: b.name(t), inkPx, rleChars: raw2.resume.ink.length });
  };

  // ---- 场景 3：提示说理不报答案 ---------------------------------------------------------------------

  const hint = async () => {
    const game = await startPuzzle('c0p0');
    const sol = solOf('c0p0');
    eq('开局无墨', game.filled, 0);
    await click('#btn-hint');
    const hm = game.hintMark;
    ck('提示挂上了推导标记', !!hm, JSON.stringify(hm));
    if (!hm) return report({});
    const ruleNames = Object.values(E().Rules).map((r) => r.name);
    ck(`提示点名的规则在六条表里（实际：${hm.ruleName}）`, ruleNames.includes(hm.ruleName), String(hm.ruleName));
    ck('文案报出格子坐标', /第\d+行\d+列/.test(hm.text), hm.text);
    ck('文案不是空话', hm.text.length >= 12, `${hm.text.length} 字`);
    eq('提示理由标题', text('#hint-rule'), `规则：${hm.ruleName}`);
    eq('理由框原文与事件同源', text('#hint-line'), hm.text);
    eq('计费一次', Number(text('#stat-hints')), 1);
    eq('按钮角标同步', text('#hint-count'), '1');

    // 关键：提示不代笔。棋盘上不许出现任何数字。
    eq('提示之后棋盘仍是空盘', game.filled, 0);
    eq('整盘墨水都没变', Array.from(game.values).join(','), new Array(sol.length).fill(0).join(','));
    ck('提示把结论落成候选（这格候选非空）', game.notes[hm.cell] > 0, `notes[${hm.cell}]=${game.notes[hm.cell]}`);
    if (hm.digit != null) {
      eq('place 类提示：候选收敛到那个数', game.notes[hm.cell], 1 << hm.digit);
      ck('说出的数字与解一致（推理正确性，非抄答案）', sol[hm.cell] === hm.digit, `提示 ${hm.digit} / 解 ${sol[hm.cell]}`);
    }
    if (hm.killed != null) {
      ck('prune 类提示：被划掉的候选真的没了', !(game.notes[hm.cell] & (1 << hm.killed)), `划掉 ${hm.killed} 后 mask=${game.notes[hm.cell]}`);
    }
    const raw = JSON.parse(localStorage.getItem(KEY));
    eq('提示次数落盘', raw.resume.hints, 1);

    // 同一格连点两次：文案一致或如实推进，不许偷偷代笔
    const before = { text: hm.text, cell: hm.cell, hints: game.hints };
    await click('#btn-hint');
    const hm2 = game.hintMark;
    if (game.hints === before.hints + 1) {
      ck('第二次提示文案仍是完整推理句', hm2.text.length >= 12 && /第\d+行\d+列|run/.test(hm2.text), hm2.text);
      ck('同一格再点：要么推进要么逐字一致', hm2.cell !== before.cell || hm2.text === before.text, `${before.cell}:${before.text} ⇒ ${hm2.cell}:${hm2.text}`);
      eq('第二次仍不代笔', game.filled, 0);
      eq('提示计数与计费一致', Number(text('#stat-hints')), game.hints);
    } else {
      const st = game.state();
      ck('推到头时如实说明', /尽头|夹/.test(st.message || ''), st.message);
      eq('不计费时计数不动', Number(text('#stat-hints')), before.hints);
    }
    return report({ hint1: hm.text, charged: game.hints, rule: hm.ruleName });
  };

  // ---- 场景 4：玩家把自己推死后，提示改口且不收费 ----------------------------------------------------

  const conflict = async () => {
    const game = await startPuzzle('c0p0');
    const b = game.board;
    const sol = solOf('c0p0');
    // 找一条"合法但与解相悖"的落子序列，把 solve(seed) 推到矛盾。
    const findPath = () => {
      const vals = new Uint8Array(b.n);
      const path = [];
      let nodes = 0;
      const dfs = () => {
        if (++nodes > 4000) return false;
        for (let t = 0; t < b.n; t++) {
          if (vals[t]) continue;
          for (let d = 1; d <= 9; d++) {
            if (d === sol[t] || !E().legalPlace(b, vals, t, d).ok) continue;
            vals[t] = d;
            path.push([t, d]);
            if (E().solve(b, { seed: vals }).conflict) return true;
            if (dfs()) return true;
            vals[t] = 0;
            path.pop();
          }
        }
        return false;
      };
      return dfs() ? { path, nodes } : null;
    };
    const found = findPath();
    ck('能构造出合法但救不回来的局面', !!found, found ? '' : 'DFS 4000 节点内找不到');
    if (!found) return report({});
    const path = found.path;
    // 通过真实输入通道回放
    for (const [t, d] of path) {
      A().selectGrid(b.cellOf[t]);
      const r = A().press(d);
      ck(`回放 ${b.name(t)}=${d} 被界面接受`, r && r.ok, JSON.stringify(r));
    }
    eq('矛盾前提示计数 0', game.hints, 0);
    const r = A().hint();
    eq('矛盾时提示拒绝落子', r.ok, false);
    eq('矛盾时不收费', r.charged, false);
    eq('提示之后计数仍 0', game.hints, 0);
    ck('改口话术点名矛盾来源', /^不用花提示：/.test(game.message), game.message);
    ck('矛盾句带着盘面坐标或 run 名', /第\d+行|run|列|格/.test(game.message), game.message);
    const line = text('#state-line');
    ck('状态行把矛盾说出来', /撞破|不用花提示/.test(line), line);
    eq('角标仍 0（没偷偷计费）', text('#hint-count'), '0');
    const raw = JSON.parse(localStorage.getItem(KEY));
    eq('存档里的提示数也是 0', raw.resume.hints, 0);

    // 退干净之后，提示重新可收费
    let guard = 0;
    while (game.filled > 0 && guard++ < 200) A().undo();
    eq('撤销能退回空盘', game.filled, 0);
    const r2 = A().hint();
    ck('退干净后提示恢复服务', r2.ok === true && r2.charged === true, JSON.stringify(r2));
    eq('这一次才计一次', game.hints, 1);
    return report({ pathLen: path.length, dfsNodes: found.nodes, conflictMsg: game.message });
  };

  // ---- 场景 5：照解填完入门第 1 局 → 判胜（独立验收） ------------------------------------------------

  const win = async () => {
    A().store.reset();
    await wait(20);
    $('.chapter[data-chapter="0"]').click();
    await wait(60);
    await A().settled();
    const game = A().game;
    const b = game.board;
    eq('开的是 c0p0', game.puzzle.id, 'c0p0');
    const sol = solOf('c0p0');
    eq('入门第 1 局白格数（实测对拍）', b.n, 9);

    // 第一格走真实点击 + 键盘，其余走同一 press 通道
    await tapOrdinal(0);
    await key(String(sol[0]));
    for (let t = 1; t < b.n; t++) {
      A().selectGrid(b.cellOf[t]);
      const r = A().press(sol[t]);
      ck(`落子 ${b.name(t)}=${sol[t]}`, r && r.ok, JSON.stringify(r));
    }
    await wait(40);
    eq('照解填完即判胜', game.status, 'won');
    ck('胜利遮罩出现', shown('#win-veil'));
    ck('胜利文案带档位与尺寸', /入门 · 5×5/.test(text('#win-meta')), text('#win-meta'));
    ck('胜利文案带步数与提示', /9 步 · 提示 0 次/.test(text('#win-meta')), text('#win-meta'));
    ck('章节进度写进文案', /本章 1\/5/.test(text('#win-meta')), text('#win-meta'));
    ck('状态行宣布全部对上', /全部对上/.test(text('#state-line')), text('#state-line'));
    eq('纯手工通关：提示 0', text('#stat-hints'), '0');
    eq('步数恰好等于格数', text('#stat-moves'), '9');

    // 独立验收：verify() 重扫网格 + count.js 第二套实现穷举数解
    const bad = E().verify(b, game.values);
    eq('独立验收 verify() 零违反', bad.length, 0);
    eq('complete() 判满盘', E().complete(b, game.values), true);
    const c = E().countSolutions(b, { limit: 2 });
    eq('穷举计数器数到唯一解', c.status, E().UNIQUE);
    eq('穷举的解与玩家填的逐格相同', Array.from(E().toDense(b, c.values)).join(','), Array.from(game.values).join(','));
    ck('穷举节点数在预算内', c.nodes < c.budget, `${c.nodes}/${c.budget}`);

    // 纪录与续档：赢了就不该再有可继续的盘
    const raw = JSON.parse(localStorage.getItem(KEY));
    eq('胜利后续档清空', JSON.stringify(raw.resume), 'null');
    const best = raw.best['c0p0'];
    ck('这一局留下纪录', !!best, JSON.stringify(raw.best));
    eq('纪录提示 0 次', best.hints, 0);
    eq('纪录步数 9', best.moves, 9);
    ck('章节标记包含 c0p0', Array.isArray(raw.chapters['0']) && raw.chapters['0'].includes('c0p0'), JSON.stringify(raw.chapters));
    const again = $('#btn-again').getBoundingClientRect();
    ck('胜利卡的按钮可点', again.width >= 44 && again.height >= 44, JSON.stringify({ w: again.width, h: again.height }));
    return report({ nodes: c.nodes, moves: game.moves, winMeta: text('#win-meta') });
  };

  // ---- 场景 6a/6b：刷新不丢档 -----------------------------------------------------------------------

  const resumeA = async () => {
    const game = await startPuzzle('c0p0');
    const b = game.board;
    const sol = solOf('c0p0');
    await tapOrdinal(0);
    await key(String(sol[0]));
    await tapOrdinal(1);
    await key(String(sol[1]));
    await click('#btn-mode-note');
    await tapOrdinal(3);
    await key('2');
    await key('5');
    await click('#btn-mode-ink');
    A().hint();
    await wait(30);
    const snap = {
      values: Array.from(game.values),
      notes: Array.from(game.notes),
      moves: game.moves,
      hints: game.hints,
      ms: game.tick(),
    };
    ck('这局有墨水也有铅笔', snap.values.some((v) => v > 0) && snap.notes.some((nv) => nv > 0), JSON.stringify(snap.values));
    ck('计时在走', snap.ms >= 0, String(snap.ms));
    const raw = JSON.parse(localStorage.getItem(KEY));
    eq('落盘 ink 与棋盘逐格一致', Array.from(E().rleDecode(raw.resume.ink, b.n)).join(','), snap.values.join(','));
    eq('落盘 notes 与棋盘逐格一致', Array.from(E().decodeNotes(raw.resume.notes, b.n)).join(','), snap.notes.join(','));
    eq('落盘 moves', raw.resume.moves, snap.moves);
    eq('落盘 hints', raw.resume.hints, snap.hints);
    ck('落盘 ms > 0', raw.resume.ms > 0, String(raw.resume.ms));
    w.sessionStorage.setItem(SNAP, JSON.stringify(snap));
    return report({ filled: snap.values.filter((v) => v).length, moves: snap.moves, hints: snap.hints, ms: snap.ms });
  };

  const resumeB = async () => {
    // 本场景在「真刷新」之后运行：playtest.cjs 每次都重新 navigate，读到的
    // localStorage 来自磁盘而不是内存。
    const rawSnap = w.sessionStorage.getItem(SNAP);
    const snap = rawSnap ? JSON.parse(rawSnap) : null;
    ck('拿到刷新前的快照', !!snap, 'sessionStorage 快照丢失');
    if (!snap) return report({});
    ck('刷新后直接是章节页（不擅自开局）', shown('#view-menu') && !shown('#view-game'));
    ck('继续卡出现', shown('#resume-card'));
    ck('继续卡写了档位与尺寸', /入门（5×5）/.test(text('#resume-name')), text('#resume-name'));
    ck('继续卡写了花费', new RegExp(`${snap.moves} 步 · 提示 ${snap.hints} 次 · 没打完`).test(text('#resume-meta')), text('#resume-meta'));
    const raw = JSON.parse(localStorage.getItem(KEY));
    eq('刷新后磁盘上的 ink 未变形', Array.from(E().rleDecode(raw.resume.ink, 9)).join(','), snap.values.join(','));

    await click('#btn-resume');
    await A().settled();
    const game = A().game;
    const b = game.board;
    ck('继续之后进了棋局', shown('#view-game'));
    eq('墨水逐格回来', Array.from(game.values).join(','), snap.values.join(','));
    // restore() 的设计：notes=0 的空位回默认候选域。落子的格墨水在前、候选被数字盖住，
    // 与落子前（placeInk 清候选）在玩家眼里等价；空格上的铅笔必须逐格还原。
    const expectNotes = snap.notes.map((nv, i) => (snap.values[i] ? b.initMask[i] : nv));
    eq('空格铅笔逐格回来（含提示收敛的候选）', Array.from(game.notes).join(','), expectNotes.join(','));
    ck('至少一格玩家手写的铅笔回来了', snap.notes[3] > 0 && game.notes[3] === snap.notes[3], `notes[3] ${snap.notes[3]} -> ${game.notes[3]}`);
    eq('步数回来', game.moves, snap.moves);
    eq('提示数回来（刷新不是免费重开）', game.hints, snap.hints);
    eq('面板步数读数', text('#stat-moves'), String(snap.moves));
    eq('面板提示读数', text('#stat-hints'), String(snap.hints));
    ck('计时接着走而不是清零', A().elapsed() >= snap.ms, `${A().elapsed()} vs ${snap.ms}`);
    eq('盘面编码与 c0p0 相同', JSON.stringify(E().encodeBoard(game.board)) === JSON.stringify(A().puzzleById('c0p0').code), true);
    // 续上之后还能正常玩
    const sol = solOf('c0p0');
    const t = Array.from(game.values).findIndex((v) => !v);
    ck('还有空格可下', t >= 0, String(t));
    A().selectGrid(b.cellOf[t]);
    await key(String(sol[t]));
    eq('续档后还能落子', game.values[t], sol[t]);
    eq('落子又写回磁盘', E().rleDecode(JSON.parse(localStorage.getItem(KEY)).resume.ink, 9)[t], sol[t]);
    return report({ restoredFilled: game.filled, ms: snap.ms, cells: b.n });
  };

  // ---- 场景 7a/7b/7c：脏存档吞得下、不白屏、能重置 -----------------------------------------------------

  const dirtyA = async () => {
    // 第一段：结构就坏的 resume、类型全是错的账本
    localStorage.setItem(KEY, JSON.stringify({
      version: 99,
      resume: { code: { w: 5, h: 5, bl: 'short', ac: 'x', dn: 'x' }, ink: 'zz!!', notes: 42, moves: -4, hints: 'x', ms: 1e15, status: 'won', tier: 99, chapter: 77, index: -9 },
      best: { c0p0: { moves: 'many', hints: -3, ms: -9, date: 'x'.repeat(40) }, ['y'.repeat(200)]: { moves: 1, hints: 0, ms: 1 } },
      daily: { '20269-09-27': { done: true }, 'not-a-day': { done: true }, '2026-09-27': { done: true, tier: -4 } },
      chapters: { 0: ['ok', 42, 'z'.repeat(200)], later: 'notarray' },
      options: { muted: 'yes', tier: 999, hideNotes: 7 },
    }));
    ck('脏数据写进磁盘成功', localStorage.getItem(KEY).includes('"version":99'), '写入失败');
    ck('当前页面仍活着（脏数据在下次启动才生效）', !!A().version, 'nope');
    // 第二段的弹药：形状合法但内容荒诞（值全在界外）
    const lv = E().LEVELS.find((p) => p.id === 'c0p0');
    w.sessionStorage.setItem(SNAP, JSON.stringify({
      resume: { code: lv.code, ink: E().rleEncode(new Uint8Array(lv.cells).fill(44)), notes: 'nonsense..', moves: 1e12, hints: -3, ms: -7, status: 'whatever' },
      best: {}, daily: {}, chapters: {}, options: {},
    }));
    return report({ stage: 'garbage1-written' });
  };

  const dirtyB = async () => {
    ck('结构坏的脏数据启动不白屏', !!A().version && shown('#view-menu'), JSON.stringify({ v: A().version && A().version, menu: shown('#view-menu') }));
    eq('无未捕获异常', errors.length, 0);
    const s = A().store.state;
    eq('坏 resume 被整条丢掉', s.resume, null);
    eq('荒诞 best 全部拒收', JSON.stringify(s.best), '{}');
    eq('chapters 只留合法项', JSON.stringify(s.chapters), JSON.stringify({ 0: ['ok'] }));
    eq('daily 只留合法日型', JSON.stringify(Object.keys(s.daily)), JSON.stringify(['2026-09-27']));
    eq('daily 越界 tier 夹到 0', s.daily['2026-09-27'].tier, 0);
    eq('options.tier 越界夹到上限 8', s.options.tier, 8);
    eq('布尔字段用 !! 清洗', `${s.options.muted}/${s.options.hideNotes}`, 'true/true');
    eq('版本号以代码为准', s.version, 1);
    // 还能正常开局玩
    const game = await startPuzzle('c0p0');
    A().selectGrid(game.board.cellOf[0]);
    await key(String(solOf('c0p0')[0]));
    eq('脏档之后仍能落子', game.values[0], solOf('c0p0')[0]);
    const garbage2 = JSON.parse(w.sessionStorage.getItem(SNAP));
    localStorage.setItem(KEY, JSON.stringify(garbage2));
    eq('第二段弹药已上膛', garbage2.resume.ink.length > 0, garbage2.resume.ink);
    return report({ stage: 'garbage2-written', sanitizedTier: s.options.tier });
  };

  const dirtyC = async () => {
    ck('半合法脏档启动不白屏', !!A().version && shown('#view-menu'), 'nope');
    eq('仍然无未捕获异常', errors.length, 0);
    const s = A().store.state;
    ck('resume 形状过关后留下', !!s.resume, JSON.stringify(s.options));
    ck('界外墨水值被夹回 0..9', s.resume.values.every((v) => v >= 0 && v <= 9), JSON.stringify(Array.from(s.resume.values)));
    eq('越界 44 夹到 9', s.resume.values[0], 9);
    eq('负数/超界计数各归各位', `${s.resume.moves}/${s.resume.hints}/${s.resume.ms}`, '1000000/0/0');
    eq('status 只认 won/playing', s.resume.status, 'playing');
    eq('乱码 notes 被 decodeNotes 吞成 0', Array.from(s.resume.notes).join(','), new Array(9).fill(0).join(','));
    await click('#btn-resume');
    await A().settled();
    const game = A().game;
    ck('强行续这盘也进得来（不白屏）', shown('#view-game') && !!game, 'game=null');
    ck('满盘假数字被 run 判定看住（不判胜、报冲突）', game.status === 'playing' && game.state().conflicts > 0, JSON.stringify({ st: game.status, cf: game.state().conflicts }));
    ck('状态行说出来', /撞破/.test(text('#state-line')), text('#state-line'));
    await click('#btn-menu');
    await click('#btn-reset');
    const raw = JSON.parse(localStorage.getItem(KEY));
    eq('reset 真清盘（磁盘）', raw.resume, null);
    eq('reset 也清了内存', JSON.stringify(A().store.state.best), '{}');
    eq('清完只剩这一个键', Object.keys(localStorage).join(','), KEY);
    const g2 = A().start(A().puzzleById('c0p1'));
    eq('重置后仍能开局', g2.puzzle.id, 'c0p1');
    return report({ clamped: Array.from(s.resume.values).slice(0, 4), conflicts: game.state().conflicts });
  };

  // ---- 场景 8：触摸目标与命中 -------------------------------------------------------------------------

  const touch = async () => {
    A().store.reset();
    A().show('menu');
    await wait(40);
    const rects = [];
    for (const sel of ['.chapter', '.tier', '#btn-daily']) {
      for (const e of $$(sel)) {
        const r = e.getBoundingClientRect();
        rects.push({ what: `${sel}[${e.dataset.chapter ?? e.dataset.tier ?? 'daily'}]`, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    const minMenu = rects.reduce((a, x) => Math.min(a, x.w, x.h), 1e9);
    eq('菜单按钮数（5 章 + 5 档 + 日课）', rects.length, 11);
    ck(`菜单交互目标 ≥44×44（实测最小 ${minMenu}px）`, minMenu >= 44, JSON.stringify(rects.slice(0, 4)));

    const game = await startPuzzle('c0p0');
    const b = game.board;
    const pad = [];
    for (const sel of ['#keypad .pad-key', '.modes button', '.acts button', '.pad-acts button', '.top-actions button']) {
      for (const e of $$(sel)) {
        const r = e.getBoundingClientRect();
        pad.push({ what: `${sel}#${e.id || e.dataset.digit || ''}`, w: Math.round(r.width), h: Math.round(r.height) });
      }
    }
    eq('数字键盘九键', pad.filter((x) => x.what.includes('pad-key')).length, 9);
    const minPad = pad.reduce((a, x) => Math.min(a, x.w, x.h), 1e9);
    const smallOnes = pad.filter((x) => x.w < 44 || x.h < 44);
    ck(`对局页全部按钮 ≥44×44（实测最小 ${minPad}px，共 ${pad.length} 个）`, smallOnes.length === 0, JSON.stringify(smallOnes.slice(0, 3)));
    ck('提示/检查/撤销/换局/回章节都在', ['#btn-hint', '#btn-check', '#btn-undo', '#btn-new', '#btn-menu'].every((id) => $(id)), 'missing');

    const L = A().layout();
    ck(`格径保 44（实测 ${L.cell}px）`, L.cell >= 44, String(L.cell));
    eq('触摸目标达标时 data-touch=1', $('#board').dataset.touch, '1');

    // 命中测试：每个白格的中心与四角内缩点都落回本格
    let misses = 0;
    const badHit = [];
    for (let t = 0; t < b.n; t++) {
      const g = b.cellOf[t];
      const r = A().view.cellRect(g);
      const probes = [
        [r.x + r.size / 2, r.y + r.size / 2],
        [r.x + 4, r.y + 4],
        [r.x + r.size - 5, r.y + 4],
        [r.x + 4, r.y + r.size - 5],
        [r.x + r.size - 5, r.y + r.size - 5],
      ];
      for (const [x, y] of probes) {
        const hit = A().hitAt(x, y);
        if (!hit || hit.grid !== g) {
          misses++;
          if (badHit.length < 3) badHit.push({ t, probe: [Math.round(x), Math.round(y)], got: hit && hit.grid });
        }
      }
    }
    eq('白格 5 点位全部命中本格', misses, 0);
    void badHit;

    // 点黑格不改选中
    let blackGrid = -1;
    for (let g = 0; g < b.size; g++) if (b.black[g] && b.down[g] > 0 && b.across[g] > 0) { blackGrid = g; break; }
    ck('找到带双线索的黑格', blackGrid >= 0, String(blackGrid));
    const selBefore = game.sel;
    await tapGrid(blackGrid);
    eq('点黑格不改变选中（黑格不是能填的格）', game.sel, selBefore);

    // 键盘全链路
    const t0 = game.sel;
    await key('ArrowRight');
    ck('方向键能换选中格', game.sel !== t0, `sel ${t0} -> ${game.sel}`);
    await key('n');
    eq('N 键切铅笔模式', game.mode, 'note');
    await key('n');
    await key('h');
    eq('H 键给一次提示', game.hints, 1);
    const u = A().undo();
    ck('Z 键的撤销通道返回明确结论（真退或如实拒）', u && typeof u.ok === 'boolean', JSON.stringify(u));
    ck('页面无横向溢出', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1, `${document.documentElement.scrollWidth} vs ${document.documentElement.clientWidth}`);
    ck('画布完整在视口里', $('#board').getBoundingClientRect().right <= window.innerWidth + 1, String($('#board').getBoundingClientRect().right));
    return report({ minTouchBtn: minPad, minTouchMenu: minMenu, cell: L.cell, probes: b.n * 5, buttons: pad.length });
  };

  // ---- 场景 9：黑格/白格几何与线索落位 -----------------------------------------------------------------

  const geom = async () => {
    const C = colors();
    const runChecks = (game, limit) => {
      const b = game.board;
      const v = A().view;
      let whereBad = 0;
      const badWhere = [];
      let litBad = 0;
      const badLit = [];
      const runs = limit ? b.runs.slice(0, limit) : b.runs;
      for (const run of runs) {
        const gs = run.gridCells;
        const r0 = Math.floor(gs[0] / b.w);
        const c0 = gs[0] % b.w;
        const r1 = Math.floor(gs[gs.length - 1] / b.w);
        const c1 = gs[gs.length - 1] % b.w;
        const want = run.dir === E().ACROSS
          ? `第${r0 + 1}行 ${c0 + 1}~${c1 + 1}列 的横向 run`
          : `第${c0 + 1}列 ${r0 + 1}~${r1 + 1}行 的纵向 run`;
        if (run.where !== want) {
          whereBad++;
          if (badWhere.length < 3) badWhere.push({ got: run.where, want });
        }
        const rect = v.cellRect(run.home);
        const s = rect.size;
        const upRight = countIn(rect.x + s * 0.5, rect.y + s * 0.08, s * 0.44, s * 0.38, C.paper, 26);
        const dnRight = countIn(rect.x + s * 0.5, rect.y + s * 0.58, s * 0.44, s * 0.34, C.paper, 26);
        const mine = run.dir === E().ACROSS ? dnRight : upRight;
        const foreign = run.dir === E().ACROSS ? upRight : dnRight;
        const otherHomeClue = run.dir === E().ACROSS ? b.dn[run.home] : b.ac[run.home];
        const foreignOk = otherHomeClue > 0 ? foreign >= 3 : foreign === 0;
        if (!(mine >= 3 && foreignOk)) {
          litBad++;
          if (badLit.length < 3) badLit.push({ where: run.where, dir: run.dir, mine, foreign, otherHomeClue, rect: [Math.round(rect.x), Math.round(rect.y), s] });
        }
      }
      return { runs: runs.length, whereBad, badWhere, litBad, badLit };
    };

    const g5 = await startPuzzle('c0p0');
    const L5 = A().layout();
    eq('5×5 画布 CSS 宽 = cell×w+2P', L5.cssWidth, L5.cell * 5 + 12);
    eq('5×5 画布 CSS 高 = cell×h+2P', L5.cssHeight, L5.cell * 5 + 12);
    const q5 = runChecks(g5, 0);
    eq('入门局每条 run 的 where 与网格坐标对拍', q5.whereBad, 0);
    eq('入门局每条线索点亮 home 的正确象限', `${q5.runs - q5.litBad}/${q5.runs}`, `${q5.runs}/${q5.runs}`);
    ck('可疑线索坐标为 0', q5.badLit.length === 0, JSON.stringify(q5.badLit));
    ck('where 可疑为 0', q5.badWhere.length === 0, JSON.stringify(q5.badWhere));

    const g10 = await startPuzzle('c4p0');
    await A().settled();
    const b10 = g10.board;
    const L10 = A().layout();
    eq('烧脑局 10×10', `${L10.w}×${L10.h}`, '10×10');
    eq('10×10 画布 CSS 宽 = cell×w+2P', L10.cssWidth, L10.cell * 10 + 12);
    ck('同窗口下大盘格径收紧', L10.cell < L5.cell, `${L10.cell} < ${L5.cell}`);
    ck('大盘画布更宽', L10.cssWidth >= L5.cssWidth, `${L10.cssWidth} vs ${L5.cssWidth}`);
    eq('data-touch 诚实反映格径', $('#board').dataset.touch, L10.cell >= 44 ? '1' : '0');
    ck('格径不低于硬下限 26', L10.cell >= 26, String(L10.cell));
    const q10 = runChecks(g10, 8);
    eq('烧脑局抽样 8 条 run 的 where 对拍', q10.whereBad, 0);
    eq('烧脑局抽样线索全部落位', `${q10.runs - q10.litBad}/${q10.runs}`, `${q10.runs}/${q10.runs}`);
    ck('抽样可疑坐标为 0', q10.badLit.length === 0, JSON.stringify(q10.badLit));

    // 底色几何：黑格中心偏暗（避开对角线，取左下侧）、白格亮
    let darkBad = 0;
    const darkSamples = [];
    let blackSeen = 0;
    for (let g = 1; g < b10.size; g++) {
      if (!b10.black[g]) continue;
      const r = A().view.cellRect(g);
      const px = pixel(r.x + r.size * 0.28, r.y + r.size * 0.62);
      darkSamples.push(px);
      if (!near(px, C.black, 40)) darkBad++;
      if (++blackSeen >= 12) break;
    }
    eq('黑格底色为深格色（12 个采样）', darkBad, 0);
    // 挑一个既没选中也不在选中 run 里的白格
    const selRuns = [b10.acrossRun[g10.sel], b10.downRun[g10.sel]];
    let probe = -1;
    for (let t = b10.n - 1; t >= 0; t--) {
      if (t === g10.sel) continue;
      if (selRuns.includes(b10.acrossRun[t]) || selRuns.includes(b10.downRun[t])) continue;
      probe = t;
      break;
    }
    ck('找到中性白格', probe >= 0, String(probe));
    const rw = A().view.cellRect(b10.cellOf[probe]);
    const whitePx = pixel(rw.x + rw.size * 0.12, rw.y + rw.size * 0.88);
    ck('白格是亮格色', near(whitePx, C.tile, 20) || near(whitePx, C.tileAlt, 20), `${whitePx} @${b10.name(probe)}`);
    return report({ cell5: L5.cell, cell10: L10.cell, runs5: q5.runs, runs10sampled: q10.runs, blackSamples: blackSeen });
  };

  w.__scn = {
    first,
    play,
    hint,
    conflict,
    win,
    'resume-a': resumeA,
    'resume-b': resumeB,
    'dirty-a': dirtyA,
    'dirty-b': dirtyB,
    'dirty-c': dirtyC,
    touch,
    geom,
  };
})(window);
