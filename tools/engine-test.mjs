// 引擎单元测试，纯 Node 跑：`node tools/engine-test.mjs`（= npm test）。
//
// 这个仓的风险不在算术，在**可靠性**：只要有一条规则写出一个线索并没逼出来的数字，每一局照样能
// 出货、提示照样自洽、"零猜测"照样写在门面上。所以这里的期望值全部来自三处**独立**来源，一处都不
// 许是"代码现在输出什么就期望什么"：
//   ① 手算的字面量（A/B 节的组合数学与哨兵值、I/J 节的编码与存档形状）
//   ② 本文件自带的第三套实现 `allSolutions()`：自己扫网格、自己按行主序回溯、数出**全部**解。
//      它既不 import kakuro.js 也不 import count.js —— C/D 节拿它当裁判，逐条确认铅笔的结论。
//   ③ count.js 的穷举计数器 —— E/F/H 节拿它跟 solve() 的铅笔逐格比对
// ②与③互不信任、①与谁都不同源。把 Rules 表和 count.js 的几何表合并成"公共表"就是自欺。
//
// 每节都打实测数字（不是只打 ok），失败信息一律带"当前值 / 期望值 / 哪一盘的哪一格"。

import {
  ACROSS,
  BLACK,
  CHARS,
  DOWN,
  EMPTY,
  MAX_DIGIT,
  MAX_ENCODED,
  NO_CLUE,
  RULE_LEVELS,
  Rules,
  WHITE,
  cellName,
  cluesFrom,
  complete,
  createBoard,
  decodeColumn,
  diagnose,
  encodeBoard,
  encodeColumn,
  legalPlace,
  reachable,
  solve,
  verify,
} from '../js/engine/kakuro.js';
import {
  BITS,
  FIRST,
  MAX_RUN,
  MIN_DIGIT,
  POP,
  clueLegal,
  countCombinations,
  countTable,
  digitSetOf,
  digitsOf,
  enumerateCombos,
  maxSum,
  minSum,
} from '../js/engine/combos.js';
import {
  DEFAULT_MAX_NODES,
  MANY,
  NONE,
  OVERBUDGET,
  UNIQUE,
  buildRuns,
  countSolutions,
  diffCells,
  toDense,
  uniqueSolution,
} from '../js/engine/count.js';
import {
  MAX_TIER,
  TIERS,
  audit,
  checkStructure,
  decodePuzzle,
  makePuzzle,
  measure,
  plantDigits,
  puzzleId,
  redundantClues,
  sampleStructure,
  tierFor,
} from '../js/engine/generate.js';
import { mix } from '../js/engine/rng.js';
import { BAKE, LEVELS } from '../js/data/levels.js';
import {
  KEY,
  VERSION,
  betterThan,
  createStore,
  decodeNotes,
  encodeNotes,
  rleDecode,
  rleEncode,
  sanitize,
  sanitizeBest,
  sanitizeCode,
  sanitizeResume,
} from '../js/store.js';

// ---- 断言器 ----------------------------------------------------------------------------------

let pass = 0;
let fail = 0;
let section = '总则';
const shown = (v) => {
  if (v === undefined) return '«没有值»';
  if (v === null) return '«null»';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `«不是有限数：${String(v)}»`;
  if (typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (ArrayBuffer.isView(v)) return Array.from(v).join(',');
  try {
    return JSON.stringify(v);
  } catch {
    return '«无法序列化»';
  }
};
const same = (a, b) => {
  if (a === b) return true;
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  return false;
};
const eq = (name, got, want, detail = '') => {
  if (same(got, want) || String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  ✗ ${section} · ${name}\n      收到 ${shown(got)}\n      应为 ${shown(want)}${detail ? `\n      ${detail}` : ''}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond === true) pass++;
  else {
    fail++;
    console.log(`  ✗ ${section} · ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};
const head = (title) => {
  section = title;
  console.log(`\n【${title}】`);
};
const note = (msg) => console.log(`  · ${msg}`);
const throwsWith = (name, fn, ...needles) => {
  let msg = '';
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    msg = e && e.message ? e.message : shown(e);
  }
  if (!threw) {
    ok(name, false, '本该抛错，却安安静静返回了');
    return '';
  }
  const missing = needles.filter((s) => !msg.includes(s));
  ok(name, missing.length === 0, `错误信息「${msg}」没说清 ${JSON.stringify(missing)}`);
  return msg;
};

// ---- 人工盘：图样 + 手植数字，线索由本文件自己扫网格算出来 -------------------------------------
//
// 这些数字是我在纸上排好的（每条 run 互不重复、和落在合法区间），所以期望值可以先于代码写下来。
// createBoard 的规矩：第 1 行、第 1 列必须整条是黑格 —— 每条 run 都得有人写它的和。

const scanGrid = (w, h, black, val) => {
  const runs = [];
  const isBlack = (r, c) => black[r * w + c] === 1;
  for (let r = 1; r < h; r++) {
    let c = 1;
    while (c < w) {
      if (isBlack(r, c)) {
        c++;
        continue;
      }
      const start = c;
      const cells = [];
      let sum = 0;
      while (c < w && !isBlack(r, c)) {
        cells.push(r * w + c);
        sum += val[r * w + c];
        c++;
      }
      runs.push({ dir: 'A', home: r * w + start - 1, cells, clue: sum, len: cells.length });
    }
  }
  for (let c = 1; c < w; c++) {
    let r = 1;
    while (r < h) {
      if (isBlack(r, c)) {
        r++;
        continue;
      }
      const start = r;
      const cells = [];
      let sum = 0;
      while (r < h && !isBlack(r, c)) {
        cells.push(r * w + c);
        sum += val[r * w + c];
        r++;
      }
      runs.push({ dir: 'D', home: (start - 1) * w + c, cells, clue: sum, len: cells.length });
    }
  }
  return runs;
};

/** 图样（'#' 黑 / '.' 白）+ 手植数字（按绝对列号对齐）→ 一盘；线索由本文件扫出来，不借引擎。 */
const hand = (pattern, digits) => {
  const h = pattern.length;
  const w = pattern[0].length;
  const black = new Int8Array(w * h).fill(1);
  const val = new Int8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (pattern[r][c] === '.') {
        black[r * w + c] = 0;
        val[r * w + c] = Number(digits[r][c]);
      }
    }
  }
  const runs = scanGrid(w, h, black, val);
  const across = new Int8Array(w * h);
  const down = new Int8Array(w * h);
  for (const run of runs) (run.dir === 'A' ? across : down)[run.home] = run.clue;
  return { board: createBoard({ w, h, black, across, down }), runs, grid: val, w, h };
};

/** 手写线索（不来自植数字）——用来造"线索互相矛盾、根本没有解"的盘。 */
const rawBoard = ({ w, h, black, across, down }) =>
  createBoard({
    w,
    h,
    black: Int8Array.from(black),
    across: Int8Array.from(across),
    down: Int8Array.from(down),
  });

// 人工盘清单（图样与数字都写在纸上过）
// H4：短 run 密集，第 4 行第 3 列那条只有 1 格
const H4 = hand(['#####', '#...#', '#...#', '##.##'], ['00000', '03570', '01940', '00600']);
// HREG：两片夹一列，进差法的"里格/外伸格"两种差集都出现
const HREG = hand(['#######', '#..####', '#.....#', '###...#'], ['0000000', '0590000', '0139870', '0004260']);
// HMANY：四条 2 格 run 各写 11 —— 手算：左上角取 2..9 都行 ⇒ 8 个解
const HMANY = hand(['####', '#..#', '#..#', '####'], ['0000', '0290', '0920', '0000']);
// HNONE：第 2 行那格横向 run 只有它自己且写着 9 ⇒ 它必须是 9；
//         同一条 2 格纵向 run 写着 3 ⇒ 两格只能是 {1,2}。两句不可能同时成立 ⇒ 无解。
const HNONE = {
  board: rawBoard({
    w: 4,
    h: 3,
    // 白格只有 (1,1) 与 (2,1) 两格；黑格家的下标：横向 run 的家在左边一格，纵向 run 的家在上边一格
    black: [1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1],
    across: [0, 0, 0, 0, 9, 0, 0, 0, 1, 0, 0, 0], // across[4]=9 → (1,1) 那格必须是 9
    down: [0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // down[1]=3 → (1,1)(2,1) 两格只能 {1,2}
  }),
};

// ---- 本文件自带的第三套实现：数出**全部**解 -----------------------------------------------------
//
// 自己扫网格、自己按行主序回溯：不带组合清单、不认得任何规则、也不 import count.js。
// C/D 节拿它当裁判 —— 规则推出的每一个结论，必须在它的**每一个**解里都成立。

const scanBoard = (board) => {
  const { w, h, black, across, down } = board;
  const whites = [];
  const ordinal = new Int32Array(w * h).fill(-1);
  for (let t = 0; t < w * h; t++) {
    if (black[t]) continue;
    ordinal[t] = whites.length;
    whites.push(t);
  }
  const runs = [];
  const isBlack = (r, c) => black[r * w + c] === 1;
  for (let r = 1; r < h; r++) {
    let c = 1;
    while (c < w) {
      if (isBlack(r, c)) {
        c++;
        continue;
      }
      const start = c;
      const cells = [];
      while (c < w && !isBlack(r, c)) {
        cells.push(r * w + c);
        c++;
      }
      runs.push({ id: runs.length, dir: 'A', home: r * w + start - 1, cells, clue: across[r * w + start - 1], len: cells.length });
    }
  }
  for (let c = 1; c < w; c++) {
    let r = 1;
    while (r < h) {
      if (isBlack(r, c)) {
        r++;
        continue;
      }
      const start = r;
      const cells = [];
      while (r < h && !isBlack(r, c)) {
        cells.push(r * w + c);
        r++;
      }
      runs.push({ id: runs.length, dir: 'D', home: (start - 1) * w + c, cells, clue: down[(start - 1) * w + c], len: cells.length });
    }
  }
  const cellRuns = Array.from({ length: w * h }, () => []);
  for (const run of runs) for (const t of run.cells) cellRuns[t].push(run.id);
  return { w, h, whites, ordinal, runs, cellRuns, n: whites.length };
};

const ALL_CACHE = new Map();
/** 穷举全部解（密集下标）。撞 `cap`/`nodeCap` 上限时如实报告 truncated。 */
const allSolutions = (board, cap = 4000, nodeCap = 8_000_000) => {
  const key = puzzleId(encodeBoard(board));
  const hit = ALL_CACHE.get(key);
  if (hit) return hit;
  const bd = scanBoard(board);
  const { whites, ordinal, runs, cellRuns, n } = bd;
  const values = new Uint8Array(n);
  const sum = runs.map(() => 0);
  const used = runs.map(() => 0);
  const posOf = runs.map((run) => {
    const m = new Map();
    run.cells.forEach((t, i) => m.set(t, i));
    return m;
  });
  const sols = [];
  let nodes = 0;
  let truncated = false;
  const dfs = (k) => {
    if (truncated) return;
    nodes++;
    if (nodes > nodeCap || sols.length > cap) {
      truncated = true;
      return;
    }
    if (k === whites.length) {
      sols.push(Uint8Array.from(values));
      return;
    }
    const t = whites[k];
    for (let d = 1; d <= MAX_DIGIT; d++) {
      let good = true;
      for (const id of cellRuns[t]) {
        const run = runs[id];
        if (used[id] & BITS(d)) {
          good = false;
          break;
        }
        const left = run.len - posOf[id].get(t) - 1;
        const s = sum[id] + d;
        // 松弛界：剩下 left 格至少 1+2+…、至多 9+8+…，加上不重复的粗略下界 left
        if (s > run.clue || s + left > run.clue || s + 9 * left < run.clue) {
          good = false;
          break;
        }
        if (left === 0 && s !== run.clue) {
          good = false;
          break;
        }
      }
      if (!good) continue;
      values[ordinal[t]] = d;
      for (const id of cellRuns[t]) {
        sum[id] += d;
        used[id] |= BITS(d);
      }
      dfs(k + 1);
      for (const id of cellRuns[t]) {
        sum[id] -= d;
        used[id] &= ~BITS(d);
      }
      values[ordinal[t]] = 0;
      if (truncated) break;
    }
  };
  dfs(0);
  const out = { sols, nodes, truncated, bd };
  ALL_CACHE.set(key, out);
  return out;
};

/** 某格在所有解里出现过的数字集合（位掩码）。 */
const supportOf = (sols, t) => {
  let m = 0;
  for (const s of sols) m |= BITS(s[t]);
  return m;
};

// ---- 库里 25 局 ------------------------------------------------------------------------------

const LIB = LEVELS.map((e) => ({ e, board: decodePuzzle(e.code) }));
const codeLabel = (e) => `${e.id}（${e.tierName} 第${e.index + 1}局 ${e.code.w}×${e.code.h}）`;
const HANDS = [
  { board: H4.board, label: '人工 H4' },
  { board: HREG.board, label: '人工 HREG' },
  { board: HMANY.board, label: '人工 HMANY' },
  { board: HNONE.board, label: '人工 HNONE（无解）' },
];

// =================================================================================================
// A 组合数学
// =================================================================================================

head('A 组合数学：enumerateCombos 与动态规划对全部 405 个 (L,S) 逐格相等');
{
  // 裁判表由本文件自己枚举 2^9 个子集算出来，跟被测的两条路都不同源。
  const ownCount = new Map();
  const ownUnion = new Map();
  // 本文件自己的裁判：1..9 的每个非空子集（9 位下标 i 表示数字 i+1）按「个数:和」归桶。
  // 引擎的掩码把数字 d 放在 bit d（bit0 空着），这里也照样用 bit d，两边才谈得上逐位比对。
  for (let sub = 1; sub < 512; sub++) {
    let cnt = 0;
    let s = 0;
    let m = 0;
    for (let i = 0; i < 9; i++) {
      if (sub & (1 << i)) {
        cnt++;
        s += i + 1;
        m |= BITS(i + 1);
      }
    }
    const key = `${cnt}:${s}`;
    ownCount.set(key, (ownCount.get(key) || 0) + 1);
    ownUnion.set(key, (ownUnion.get(key) || 0) | m);
  }
  let cells = 0;
  let legalCells = 0;
  let listed = 0;
  let countBad = 0;
  let legalBad = 0;
  let comboBad = 0;
  let setBad = 0;
  let maxRows = 0;
  let argmax = '';
  let firstBad = '（无）';
  for (let L = 1; L <= MAX_RUN; L++) {
    for (let S = 1; S <= 45; S++) {
      cells++;
      const own = ownCount.get(`${L}:${S}`) || 0;
      if (own) legalCells++;
      const dp = countCombinations(L, S);
      const list = enumerateCombos(L, S);
      if (dp !== own || list.length !== own) {
        countBad++;
        if (countBad === 1) firstBad = `L=${L} S=${S}：enumerateCombos ${list.length} 条、countCombinations ${dp} 条、本文件子集表 ${own} 条`;
      }
      if (clueLegal(L, S) !== (own > 0)) {
        legalBad++;
        if (legalBad === 1) firstBad = `L=${L} S=${S}：clueLegal 说 ${clueLegal(L, S)}，可子集表里有 ${own} 个组合`;
      }
      if (list.length > maxRows) {
        maxRows = list.length;
        argmax = `C(${L},${S})`;
      }
      for (const combo of list) {
        listed++;
        let sum = 0;
        let asc = true;
        let inside = true;
        for (let i = 0; i < combo.length; i++) {
          const d = combo[i];
          if (!(d >= MIN_DIGIT && d <= MAX_DIGIT)) inside = false;
          sum += d;
          if (i && combo[i - 1] >= d) asc = false;
        }
        if (combo.length !== L || sum !== S || !asc || !inside) {
          comboBad++;
          if (comboBad === 1) firstBad = `L=${L} S=${S} 列出了 ${JSON.stringify(combo)}`;
        }
      }
      const set = digitSetOf(L, S);
      const mine = ownUnion.get(`${L}:${S}`) || 0;
      if (set !== mine) {
        setBad++;
        if (setBad === 1) firstBad = `L=${L} S=${S}：digitSetOf 给 ${shown(digitsOf(set))}，子集并集是 ${shown(digitsOf(mine))}`;
      }
    }
  }
  eq('A1 对账覆盖的 (L,S) 格数', cells, 405);
  eq('A2 组合条数三方相等（enumerateCombos / countCombinations / 本文件子集表）', countBad, 0, firstBad);
  eq('A3 clueLegal(L,S) 的充要条件就是「L≤9 且 minSum(L)≤S≤maxSum(L)」', legalBad, 0, firstBad);
  eq(`A4 列出的 ${listed} 条组合全部升序、互不重复、数字在 1..9、和恰等于线索`, comboBad, 0, firstBad);
  eq('A5 digitSetOf 是组合数字的并集，且逐格等于本文件子集表的并集', setBad, 0, firstBad);
  eq('A6 合法 (L,S) 共 129 个（= Σ_L maxSum-minSum+1）', legalCells, 129);
  eq('A7 全部组合数 = 2^9-1 = 511（每个非空子集恰好属于一个 (L,S)）', listed, 511);
  // 端点值：全部手算
  eq('A8 minSum(1)=1', minSum(1), 1);
  eq('A9 minSum(4)=1+2+3+4=10', minSum(4), 10);
  eq('A10 maxSum(4)=9+8+7+6=30', maxSum(4), 30);
  eq('A11 maxSum(2)=9+8=17', maxSum(2), 17);
  eq('A12 minSum(9)=45 且 maxSum(9)=45', `${minSum(9)}/${maxSum(9)}`, '45/45');
  eq('A13 一条 run 最长就是 9 格', MAX_RUN, 9);
  eq('A14 和的上界 45 只有 9 格那一档能取到', `${countCombinations(9, 45)}/${countCombinations(8, 45)}`, '1/0');
  eq('A15 单格 run 的和 1..9 各一种填法', [1, 5, 9].map((s) => countCombinations(1, s)).join(','), '1,1,1');
  eq('A16 2 格和 3 只有 {1,2}', enumerateCombos(2, 3).map((c) => c.join('+')).join('|'), '1+2');
  eq('A17 2 格和 16 只有 {7,9}（不许 8+8）', enumerateCombos(2, 16).map((c) => c.join('+')).join('|'), '7+9');
  eq('A18 3 格和 24 只有 {7,8,9}', enumerateCombos(3, 24).map((c) => c.join('+')).join('|'), '7+8+9');
  eq('A19 3 格和 6 只有 {1,2,3}', enumerateCombos(3, 6).map((c) => c.join('+')).join('|'), '1+2+3');
  eq('A20 4 格和 20 的组合最多，实测 12 条', `${maxRows}@${argmax}`, '12@C(4,20)');
  eq('A21 交叉核对：C(4,20) 确实 12 条', enumerateCombos(4, 20).length, 12);
  let tenBad = 0;
  for (let S = 1; S <= 60; S++) if (clueLegal(10, S) || enumerateCombos(10, S).length || countCombinations(10, S)) tenBad++;
  eq('A22 L=10 一律非法（clueLegal / enumerateCombos / countCombinations 三方都说 0）', tenBad, 0);
  eq('A23 L=0 与负长度同样不给组合', `${clueLegal(0, 0)}/${clueLegal(-1, 5)}/${countCombinations(-1, 5)}`, 'false/false/0');
  eq('A24 非整数、NaN、字符串线索一律非法', `${clueLegal(3, 6.5)}/${clueLegal(3, NaN)}/${clueLegal(3, '6')}`, 'false/false/false');
  const tab = countTable(MAX_RUN, 45);
  let tabBad = 0;
  for (let L = 1; L <= MAX_RUN; L++) for (let S = 1; S <= 45; S++) if (tab[L][S] !== (ownCount.get(`${L}:${S}`) || 0)) tabBad++;
  eq('A25 countTable（第三条来路）与本文件子集表逐格相同', tabBad, 0);
  eq('A26 countTable 第 0 行只有 C(0,0)=1', Array.from(tab[0]).join(','), `1,${'0,'.repeat(44)}0`);
  const binom = (n, k) => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  };
  for (let L = 1; L <= MAX_RUN; L++) {
    let s = 0;
    for (let S = minSum(L); S <= maxSum(L); S++) s += enumerateCombos(L, S).length;
    eq(`A27 恒等式 Σ_S C(${L},S) = C(9,${L})`, s, binom(9, L));
  }
  eq('A28 digitsOf 只吐 1..9', digitsOf(digitSetOf(4, 20)).every((d) => d >= MIN_DIGIT && d <= MAX_DIGIT), true);
  eq('A29 POP/BITS/FIRST 三个位运算助手自洽', `${POP(BITS(7))}/${POP(BITS(5) | BITS(6))}/${FIRST(BITS(3) | BITS(9))}`, '1/2/3');
  eq('A30 空掩码 POP=0、FIRST 不会吐 0 以外的怪值', `${POP(0)}`, '0');
  note(`逐格对账 ${cells} 个 (L,S)，与本文件子集表不一致 ${countBad + legalBad + comboBad + setBad} 处；合法 ${legalCells} 个、共列出 ${listed} 条组合，最多 ${maxRows} 条出现在 ${argmax}`);
  note(`和的区间宽度：L=4、L=5 各 21 个和（10~30、15~35），L=9 只有 45 这一个和`);
}

// =================================================================================================
// B 哨兵值
// =================================================================================================

head('B 哨兵值：0 既不是合法线索也不是合法数字');
{
  eq('B1 NO_CLUE === 0', NO_CLUE, 0);
  eq('B2 EMPTY === 0', EMPTY, 0);
  eq('B3 BLACK=1 / WHITE=0', `${BLACK}/${WHITE}`, '1/0');
  eq('B4 最小数字是 1（所以 EMPTY 永远不是一个填法）', MIN_DIGIT, 1);
  eq('B5 最大数字是 9 = MAX_RUN', `${MAX_DIGIT}/${MAX_RUN}`, '9/9');
  let zeroDigitBad = 0;
  for (let L = 1; L <= 9; L++) for (let S = 1; S <= 45; S++) for (const combo of enumerateCombos(L, S)) if (combo.includes(EMPTY) || combo.some((d) => d < MIN_DIGIT)) zeroDigitBad++;
  eq('B6 405 个 (L,S) 列出的全部组合里没有 0', zeroDigitBad, 0);
  let zeroClueBad = 0;
  for (let L = 1; L <= 9; L++) if (clueLegal(L, NO_CLUE)) zeroClueBad++;
  eq('B7 0 在任何长度下都不是合法线索（一条 run 的和最小是 1）', zeroClueBad, 0);
  let bitZeroBad = 0;
  for (let L = 1; L <= 9; L++) for (let S = minSum(L); S <= maxSum(L); S++) if (digitSetOf(L, S) & 1) bitZeroBad++;
  eq('B8 数字并集里永远没有 bit0', bitZeroBad, 0);
  {
    const { board, runs, grid, w, h } = H4;
    const dense = Array.from(board.cellOf).map((t) => grid[t]);
    const snapshotA = Int8Array.from(board.across);
    const snapshotD = Int8Array.from(board.down);
    const made = cluesFrom(board, dense);
    let homeBad = 0;
    for (const run of runs) {
      const arr = run.dir === 'A' ? made.across : made.down;
      if (arr[run.home] !== run.clue || arr[run.home] <= NO_CLUE) homeBad++;
    }
    eq('B9 cluesFrom 把每条 run 的和写回它自己的黑格家', homeBad, 0);
    const homes = new Set(runs.map((r) => `${r.dir}${r.home}`));
    let stray = 0;
    for (let t = 0; t < w * h; t++) {
      if (made.across[t] > NO_CLUE && !homes.has(`A${t}`)) stray++;
      if (made.down[t] > NO_CLUE && !homes.has(`D${t}`)) stray++;
    }
    eq('B10 cluesFrom 产出的非零值只落在 run 的家格里', stray, 0);
    let zeros = 0;
    for (let t = 0; t < w * h; t++) {
      if (made.across[t] === NO_CLUE) zeros++;
      if (made.down[t] === NO_CLUE) zeros++;
    }
    eq(`B11 其余 ${zeros} 侧全是 0（="这一侧不写数"，不是"和是 0"）`, zeros, 2 * w * h - runs.length);
    const touched = shown(Array.from(board.across)) === shown(Array.from(snapshotA)) && shown(Array.from(board.down)) === shown(Array.from(snapshotD));
    eq('B12 cluesFrom 不改动传入的盘（纯函数）', touched, true, `盘上横向 ${shown(Array.from(board.across))}，调用前 ${shown(Array.from(snapshotA))}`);
    const sumA = runs.filter((r) => r.dir === 'A').reduce((a, r) => a + r.clue, 0);
    const sumD = runs.filter((r) => r.dir === 'D').reduce((a, r) => a + r.clue, 0);
    eq('B13 横向和的总和 = 纵向和的总和（同一批白格算两次）', sumA, sumD);
    const libSum = LIB.reduce((a, { board: b }) => {
      const x = Array.from(b.across).reduce((p, v) => p + v, 0);
      const y = Array.from(b.down).reduce((p, v) => p + v, 0);
      return a + (x === y ? 1 : 0);
    }, 0);
    eq('B14 库里 25 局每一局的横纵线索总和都相等', libSum, 25);
    throwsWith('B15 横向 run 的家写着 0 时直接拒绝建盘', () => {
      const across = Int8Array.from(board.across);
      across[board.runs.find((r) => r.dir === ACROSS).home] = 0;
      createBoard({ w: board.w, h: board.h, black: board.black, across, down: board.down });
    }, '左边没有写和');
    throwsWith('B16 纵向 run 的家写着 0 时直接拒绝建盘', () => {
      const down = Int8Array.from(board.down);
      down[board.runs.find((r) => r.dir === DOWN).home] = 0;
      createBoard({ w: board.w, h: board.h, black: board.black, across: board.across, down });
    }, '上边没有写和');
    throwsWith('B17 线索写 0 等于没写：全 0 线索表建不起来', () => {
      createBoard({ w: board.w, h: board.h, black: Uint8Array.from(board.black), across: new Int8Array(board.size), down: new Int8Array(board.size) });
    }, '没有写和');
  }
  const libIllegalClue = LIB.reduce((a, { board: b }) => {
    let n = 0;
    for (const r of b.runs) {
      const arr = r.dir === ACROSS ? b.across : b.down;
      const v = arr[r.home];
      if (!(v > NO_CLUE) || !clueLegal(r.len, v) || v > 45) n++;
    }
    return a + n;
  }, 0);
  const libRunCount = LIB.reduce((a, { board: b }) => a + b.runs.length, 0);
  eq(`B18 库里 ${libRunCount} 条 run 的家格里写的都是合法线索（0 只做哨兵，从不冒充和）`, libIllegalClue, 0);
  const clueSides = LIB.reduce((a, { board }) => a + board.size * 2, 0);
  const written = LIB.reduce((a, { board }) => a + board.clues, 0);
  note(`库里 25 局共 ${clueSides} 个黑格侧，写着数的只有 ${written} 侧，其余 ${clueSides - written} 侧都是 0="不写数"`);
  let clueMin = Infinity;
  let clueMax = 0;
  for (const { board } of LIB) {
    for (const arr of [board.across, board.down]) {
      for (const v of arr) {
        if (v > 0) {
          clueMin = Math.min(clueMin, v);
          clueMax = Math.max(clueMax, v);
        }
      }
    }
  }
  note(`库里单条线索实测范围：最小 ${clueMin}、最大 ${clueMax}（编码表最大要能表示 ${MAX_ENCODED}）`);
  eq('B18 编码字符表覆盖到 45', MAX_ENCODED >= 45, true);
  eq('B19 编码表有 62 个字符', CHARS.length, 62);
}

// =================================================================================================
// C 铅笔规则 soundness
// =================================================================================================

head('C 铅笔规则：每一条结论都被本文件的独立穷举确认');
{
  const boards = [...LIB.map(({ e, board }) => ({ board, label: codeLabel(e) })), ...HANDS];
  const ruleKeys = Object.keys(Rules).sort();
  const checked = {};
  const bad = {};
  const supportBad = {};
  let eventsTotal = 0;
  let boardsWithSols = 0;
  let solsTotal = 0;
  let truncatedBoards = 0;
  let pencilDone = 0;
  let pencilButNotUnique = 0;
  let pencilDiffCells = 0;
  let multi = 0;
  let none = 0;
  let firstBad = '（无）';
  const sampleEvent = {};
  for (const k of ruleKeys) {
    checked[k] = 0;
    bad[k] = 0;
    supportBad[k] = 0;
  }
  for (const { board, label } of boards) {
    const { sols, truncated } = allSolutions(board);
    solsTotal += sols.length;
    if (truncated) truncatedBoards++;
    if (sols.length === 0) none++;
    else boardsWithSols++;
    if (sols.length > 1) multi++;
    const res = solve(board);
    if (sols.length === 0) {
      // 无解盘：铅笔若"推得完"就是天大的缺陷
      ok(`${label} 无解盘不会被铅笔判为推完`, res.ok === false, 'solve().ok 竟然为 true');
      continue;
    }
    if (res.ok) {
      if (sols.length === 1 && !truncated) {
        pencilDone++;
        for (let t = 0; t < board.n; t++) if (res.values[t] !== sols[0][t]) pencilDiffCells++;
      } else pencilButNotUnique++;
    }
    for (const e of res.events) {
      const key = e.rule.key;
      if (!(e.cell >= 0 && e.cell < board.n && e.digit >= MIN_DIGIT && e.digit <= MAX_DIGIT)) {
        supportBad[key]++;
        if (supportBad[key] === 1) firstBad = `${label} 事件越界：cell=${e.cell} digit=${e.digit}`;
        continue;
      }
      eventsTotal++;
      checked[key]++;
      if (!sampleEvent[key]) sampleEvent[key] = { board, label, e };
      const where = cellName(board.w, board.cellOf[e.cell]);
      for (let i = 0; i < sols.length; i++) {
        const v = sols[i][e.cell];
        if (e.kind === 'place' && v !== e.digit) {
          bad[key]++;
          if (bad[key] === 1) firstBad = `${label} ${Rules[key].name} 在 ${where} 写下 ${e.digit}，可本文件穷举的第 ${i + 1} 个解给 ${v}`;
          break;
        }
        if (e.kind === 'prune' && v === e.digit) {
          bad[key]++;
          if (bad[key] === 1) firstBad = `${label} ${Rules[key].name} 划掉 ${where} 的 ${e.digit}，可本文件穷举出一个解就在那里写 ${e.digit}`;
          break;
        }
      }
      const sup = supportOf(sols, e.cell);
      if (e.kind === 'prune' && sup & BITS(e.digit)) supportBad[key]++;
      if (e.kind === 'place' && !(sup & BITS(e.digit))) supportBad[key]++;
    }
  }
  for (const k of ruleKeys) {
    eq(`C-${k}「${Rules[k].name}」推出的结论与独立穷举不矛盾`, bad[k], 0, firstBad);
    eq(`C-${k}「${Rules[k].name}」的并集口径成立（划掉=任何解都没有，落子=每个解都有）`, supportBad[k], 0, firstBad);
    ok(`C-${k}「${Rules[k].name}」在样本里真的触发过（这条断言不是空的）`, checked[k] > 0, `触发 ${checked[k]} 次`);
  }
  eq('C1 铅笔推得完 ⇒ 独立穷举也只数出一个解', pencilButNotUnique, 0, `推完 ${pencilDone + pencilButNotUnique} 盘`);
  eq('C2 铅笔推完的盘，其解与本文件穷举的唯一解逐格相同', pencilDiffCells, 0);
  eq('C3 规则表恰好六条', ruleKeys.length, 6);
  eq('C4 规则表的键', ruleKeys.join(','), 'bare,combo,hidden,region,slot,unique');
  eq('C5 RULE_LEVELS = 3', RULE_LEVELS, 3);
  eq('C6 每条规则的 level 都在 1..3', Object.values(Rules).every((r) => Number.isInteger(r.level) && r.level >= 1 && r.level <= RULE_LEVELS), true);
  eq('C7 每条规则的权重都是正数', Object.values(Rules).every((r) => r.weight > 0), true);
  eq('C8 每条规则都有中文名字', Object.values(Rules).every((r) => typeof r.name === 'string' && r.name.length >= 2), true);
  // 规则文本：不捏造事件对象，直接用上面采样到的**真实事件**，逐条要求它说得出位置。
  const LOCATOR = /(第\d+行\d+列|第\d+行 \d+~\d+列|第\d+列 \d+~\d+行)/;
  let textBad = 0;
  for (const k of ruleKeys) {
    const s = sampleEvent[k];
    if (!s) {
      textBad++;
      continue;
    }
    const txt = Rules[k].text(s.board, s.e);
    if (!LOCATOR.test(txt) || /undefined|NaN|«/.test(txt)) {
      textBad++;
      if (firstBad === '（无）') firstBad = `${s.label} 的「${Rules[k].name}」文本不达标：${txt}`;
    }
  }
  eq('C9 六条规则各自的真实事件文本都说得出位置（第几行第几列），且不含 undefined/NaN', textBad, 0, firstBad);
  eq('C10 六条规则各都在样本里留下过一次可渲染的真实事件', Object.keys(sampleEvent).length, 6);
  eq('C11 事件里的 rule 都是表里那六条之一', boards.every(({ board }) => solve(board).events.every((e) => Object.values(Rules).includes(e.rule))), true);
  note(`样本 ${boards.length} 盘（库里 25 + 人工 ${HANDS.length}），独立穷举出 ${solsTotal} 个解：多解盘 ${multi}、无解盘 ${none}、撞上限 ${truncatedBoards}`);
  note(`逐条确认的规则结论共 ${eventsTotal} 条：${ruleKeys.map((k) => `${Rules[k].name} ${checked[k]}`).join('、')}`);
  note(`铅笔推得完且被独立穷举确认为唯一的盘：${pencilDone} 盘`);
}

// =================================================================================================
// D 进差法
// =================================================================================================

head('D 进差法：差集前提独立复算 + 每个结论独立确认');
{
  // 本文件自己的一份"整片行列之差"：只依赖"每条 run 的和都写着"这一条事实
  const myRegion = (board, kind, from, to) => {
    const { whites, ordinal, runs } = scanBoard(board);
    const lineOf = (t) => (kind === 'rows' ? Math.floor(t / board.w) : t % board.w);
    const inside = (t) => lineOf(t) >= from && lineOf(t) <= to;
    const cells = whites.filter(inside);
    if (!cells.length) return null;
    const other = kind === 'rows' ? 'A' : 'D';
    let aSum = 0;
    let bSum = 0;
    let crossSum = 0;
    const covered = new Set();
    const outers = new Set();
    for (const run of runs) {
      const inCells = run.cells.filter(inside);
      if (!inCells.length) continue;
      if (run.dir === other) {
        if (inCells.length !== run.cells.length) return { bail: true };
        aSum += run.clue;
        continue;
      }
      if (inCells.length === run.cells.length) {
        bSum += run.clue;
        for (const t of run.cells) covered.add(t);
      } else {
        crossSum += run.clue;
        for (const t of run.cells) if (!inside(t)) outers.add(t);
      }
    }
    const innies = cells.filter((t) => !covered.has(t));
    return {
      aSum,
      bSum,
      innies: innies.map((t) => ordinal[t]),
      inniesTarget: aSum - bSum,
      outies: [...outers].map((t) => ordinal[t]),
      outiesTarget: crossSum - (aSum - bSum),
    };
  };
  const parseRegionText = (text, board) => {
    const m = /^把(行|列) ([\d、]+)看成一片：这片完整横向\/纵向 run 的和一共 (\d+)，完整落在片内的另一向 run 写着 (\d+)，所以(.+)$/.exec(text);
    if (!m) return null;
    const kind = m[1] === '行' ? 'rows' : 'cols';
    const idx = m[2].split('、').map((x) => Number(x) - 1);
    const rest = m[5];
    const many = /^这片(里|外)那 (\d+) 格（(.+)）之和必须是 (\d+)$/.exec(rest);
    const one = /^只有 (.+) 一格在这片(里|外)伸着，它必须是 (\d+)$/.exec(rest);
    let side;
    let cellNames;
    let K;
    if (many) {
      side = many[1] === '里' ? 'innies' : 'outies';
      cellNames = many[3].split('、');
      K = Number(many[4]);
    } else if (one) {
      side = one[2] === '里' ? 'innies' : 'outies';
      cellNames = [one[1]];
      K = Number(one[3]);
    } else return null;
    const cells = [];
    for (const nm of cellNames) {
      const mm = /^第(\d+)行(\d+)列$/.exec(nm);
      if (!mm) return null;
      cells.push(board.ordinal[(Number(mm[1]) - 1) * board.w + (Number(mm[2]) - 1)]);
    }
    return { kind, from: idx[0], to: idx[idx.length - 1], aSum: Number(m[3]), bSum: Number(m[4]), side, cells, K };
  };
  const boards = [...LIB.map(({ e, board }) => ({ board, label: codeLabel(e) })), ...HANDS];
  let regionEvents = 0;
  let regionBad = 0;
  let premiseChecked = 0;
  let premiseBad = 0;
  let unparsed = 0;
  let invariantChecked = 0;
  let invariantBad = 0;
  let arithmeticChecked = 0;
  let arithmeticBad = 0;
  let missingText = 0;
  let regionTextChecked = 0;
  let regionTextBad = 0;
  const boardsWithRegion = new Set();
  const sayings = new Set();
  let firstPremiseBad = '（无）';
  let firstTextBad = '（无）';
  for (const { board, label } of boards) {
    const { sols } = allSolutions(board);
    if (!sols.length) continue;
    const res = solve(board);
    const here = res.events.filter((e) => e.rule === Rules.region);
    if (here.length) boardsWithRegion.add(label);
    for (const e of here) {
      regionEvents++;
      if (!e.regionText) missingText++;
      const txt = Rules.region.text(board, e);
      regionTextChecked++;
      if (
        /undefined|NaN|«/.test(txt) ||
        (e.kind === 'place' && txt.includes('划掉')) ||
        (e.kind === 'prune' && !txt.includes('划掉'))
      ) {
        regionTextBad++;
        if (firstTextBad === '（无）') firstTextBad = `${label} 的进差法提示渲染成：${txt}`;
      }
      const where = cellName(board.w, board.cellOf[e.cell]);
      for (const sol of sols) {
        const v = sol[e.cell];
        if (e.kind === 'place' && v !== e.digit) regionBad++;
        if (e.kind === 'prune' && v === e.digit) regionBad++;
      }
      const p = parseRegionText(e.regionText || '', board);
      if (!p) {
        unparsed++;
        continue;
      }
      sayings.add(e.regionText);
      premiseChecked++;
      const mine = myRegion(board, p.kind, p.from, p.to);
      const want = p.side === 'innies' ? mine && mine.innies : mine && mine.outies;
      if (!mine || mine.bail) {
        premiseBad++;
        if (premiseBad === 1) firstPremiseBad = `${label} 引擎说的这片（${p.kind} ${p.from + 1}~${p.to + 1}）本文件算不出差集`;
      } else if (mine.aSum !== p.aSum || mine.bSum !== p.bSum) {
        premiseBad++;
        if (premiseBad === 1) firstPremiseBad = `${label} ${where}：引擎报片内和 ${p.aSum}/反向完整 run 和 ${p.bSum}，本文件扫出 ${mine.aSum}/${mine.bSum}`;
      } else if (JSON.stringify(p.cells) !== JSON.stringify(want)) {
        premiseBad++;
        if (premiseBad === 1) firstPremiseBad = `${label} ${where}：本文件圈出的${p.side === 'innies' ? '里格' : '外伸格'}是 ${JSON.stringify(want)}，引擎说的是 ${JSON.stringify(p.cells)}`;
      } else if (mine[`${p.side}Target`] !== p.K) {
        premiseBad++;
        if (premiseBad === 1) firstPremiseBad = `${label} ${where}：本文件算出差集和 ${mine[`${p.side}Target`]}，引擎说的是 ${p.K}`;
      } else if (!p.cells.includes(e.cell)) {
        premiseBad++;
        if (premiseBad === 1) firstPremiseBad = `${label} 引擎拿${p.side === 'innies' ? '片内' : '片外'}那 ${p.cells.length} 格的说辞去动 ${where}，可这一格根本不在差集里`;
      }
      let s = 0;
      for (const t of p.cells) s += sols[0][t];
      invariantChecked++;
      for (const sol of sols) {
        let x = 0;
        for (const t of p.cells) x += sol[t];
        if (x !== p.K) {
          invariantBad++;
          if (invariantBad === 1) firstPremiseBad = `${label}：${p.side === 'innies' ? '片内' : '片外'}那 ${p.cells.length} 格在某个解里和是 ${x}，进差法说必须是 ${p.K}`;
          break;
        }
      }
      if (e.kind === 'prune') {
        // 纯算术复算：只看引擎自己报出的那串候选（`candidates`）和它说出的 K，
        // 不调用任何求解器。两问：①说划掉的数字是否真的从候选里消失了（记账口径）；
        // ②留下的候选是否连"其余 rest 格各取 1..9"这种最宽的和界都过不了（那样的话
        // 文本说的和与掩码里的数就对不上了）。
        const size = p.cells.length;
        const rest = size - 1;
        const kept = String(e.candidates).split('/').map((x) => Number(x));
        arithmeticChecked++;
        if (kept.includes(e.digit)) {
          arithmeticBad++;
          if (arithmeticBad === 1) firstPremiseBad = `${label} ${where}：说划掉 ${e.digit}，可事件报的候选还是 ${e.candidates}`;
        }
        for (const v of kept) {
          if (v < MIN_DIGIT || v > MAX_DIGIT || !Number.isInteger(v)) {
            arithmeticBad++;
            if (arithmeticBad === 1) firstPremiseBad = `${label} ${where}：候选串 ${e.candidates} 里有不像数字的东西`;
            break;
          }
          const need = p.K - v;
          if (need < rest || need > 9 * rest) {
            arithmeticBad++;
            if (arithmeticBad === 1) firstPremiseBad = `${label} ${where}：${p.side === 'innies' ? '片内' : '片外'}${size} 格和必须是 ${p.K}，${where} 留 ${v} 时其余 ${rest} 格要凑 ${need}，最宽的和界 ${rest}~${9 * rest} 都容不下，却没划掉`;
            break;
          }
        }
        if (size === 1 && e.candidates !== String(p.K)) {
          arithmeticBad++;
          if (arithmeticBad === 1) firstPremiseBad = `${label} ${where}：差集只剩这一格，和必须是 ${p.K}，候选却报 ${e.candidates}`;
        }
      }
    }
  }
  eq('D1 进差法写下的每个数字都在本文件穷举的每个解里成立', regionBad, 0, `确认 ${regionEvents} 条`);
  eq('D2 进差法的适用前提（片内和、反向完整 run 的和、差集格子、差值）被正确识别', premiseBad, 0, firstPremiseBad);
  eq('D3 差集之和在每一个解上真的等于 K', invariantBad, 0, `比对 ${invariantChecked} 次`);
  eq('D4 进差法自己的记账与文本对得上（划掉的确实不在候选里、留下的候选过得了最宽和界、单格差集恰好等于 K）', arithmeticBad, 0, `检验 ${arithmeticChecked} 条；${firstPremiseBad}`);
  eq('D5 进差法的说明文字全部可解析（口径没漂）', unparsed, 0, firstPremiseBad);
  eq('D6 每条进差法事件都带着片区说明（含"夹到最后落子"那类）', missingText, 0, `${regionEvents} 条事件里 ${missingText} 条没有 regionText，提示会渲染成 undefined`);
  eq('D7 进差法事件的渲染文本不自相矛盾：落子不说"划掉"，也不许出现 undefined', regionTextBad, 0, firstTextBad);
  ok('D8 样本里进差法真的触发过（这条断言不是空的）', regionEvents > 0, `触发 ${regionEvents} 条`);
  const tierStat = TIERS.map((T) => {
    const list = LIB.filter(({ e }) => e.tier === T.idx);
    return { T, used: list.filter(({ e }) => e.regionUsed).length, needed: list.filter(({ e }) => e.regionNeeded).length, n: list.length };
  });
  for (const { T, used, needed, n } of tierStat) {
    if (T.regionMode === 'off') eq(`D9 ${T.name} 档要求一次都不碰进差法，实测用到 ${used}/${n} 局`, used, 0);
    if (T.regionMode === 'needed') eq(`D10 ${T.name} 档要求"不用就推不完"，实测 ${needed}/${n} 局`, needed, n);
  }
  let offBad = 0;
  let neededBad = 0;
  let metaBad = 0;
  for (const { e, board } of LIB) {
    const T = TIERS[e.tier];
    const weak = solve(board, { regions: false });
    const full = solve(board);
    if (T.regionMode === 'off' && !weak.ok) offBad++;
    if (T.regionMode === 'needed' && (weak.ok || !full.ok)) neededBad++;
    if (!!e.regionUsed !== !!full.regionUsed || !!e.regionNeeded !== !!(full.ok && !weak.ok)) metaBad++;
  }
  eq('D11 「off」档的盘不用进差法也推得完（低档真的只靠组合清单）', offBad, 0);
  eq('D12 「needed」档的盘不用进差法就推不完、用了才推得完（独立复算，不看生成器的读数）', neededBad, 0);
  eq('D13 库里 25 局随盘的 regionUsed/regionNeeded 读数与本文件重跑铅笔的结果一致', metaBad, 0);
  note(`进差法事件 ${regionEvents} 条，分布在 ${boardsWithRegion.size} 盘：${[...boardsWithRegion].join('、')}`);
  note(`复算的片区前提 ${premiseChecked} 条（去重后 ${sayings.size} 种说法）、差集恒等式 ${invariantChecked} 次、进差法记账口径 ${arithmeticChecked} 条、渲染文本 ${regionTextChecked} 条`);
  note(`按档实测用到进差法的局数：${tierStat.map((x) => `${x.T.name} ${x.used}/${x.n}`).join('、')}`);
  note(`片区说明缺失 ${missingText}/${regionEvents} 条、渲染文本不达标 ${regionTextBad} 条、前提复算不一致 ${premiseBad} 条`);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
