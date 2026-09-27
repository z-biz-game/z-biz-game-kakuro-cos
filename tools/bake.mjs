// 构建期烘焙：把章节题库连同每一局的答案一起钉死进 js/data/levels.js。
//
//   node tools/bake.mjs           生成（跑生成器，慢档要几十秒一局）
//   node tools/bake.mjs --check   校验：不重新生成，只从文件里的**线索串**把答案重新推一遍，
//                                 逐格比对烘进去的墨水，并把文件按同一套规则重新序列化一遍做
//                                 字节比对 —— 所以手改一个数字、改一个字段顺序都会红。
//
// 为什么答案要烘进包里：'needed' 档（难 / 8×8）现场抽一题要几十秒（3700 抽才中一个），
// 玩家等不起；烘好之后界面只是解码 + 现推，而唯一性在构建期已经被 count.js 第二套实现数过了。
//
// 校验里的三道独立关（互不信任，缺一不算绿）：
//   ① solve() 铅笔路径能从空盘推到满盘，且推出来的解过 verify() 的重扫网格验收
//   ② count.js 穷举数到恰好 1 个解，并与 ① 的解**逐格相同**
//   ③ 文件里每个读数（分数/步数/进差法/白格/线索数/穷举节点数）都与现算值相等
// ②里还嵌着一条账：每一档都单独打 `超预算 N 局`。预算用完 = 唯一解没证完 = 那一局根本不该出货，
// 所以 N 必须是 0；N 不是 0 的时候唯一的出路是加预算或把那一档的盘缩小。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TIERS, makePuzzle, decodePuzzle, measure, puzzleId, redundantClues } from '../js/engine/generate.js';
import { solve, verify, complete } from '../js/engine/kakuro.js';
import { DEFAULT_MAX_NODES, OVERBUDGET, countSolutions, diffCells, UNIQUE } from '../js/engine/count.js';
import { rleEncode, rleDecode } from '../js/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'js/data/levels.js');
const PER_CHAPTER = Number(process.env.PER_CHAPTER || 5);
const CHECK = process.argv.includes('--check');
const WANT_REDUNDANT = process.env.REDUNDANT === '1';

const seedOf = (chapter, index) => 7919 * (chapter + 1) + 101 * (index + 1) + 13;

function buildEntries() {
  const entries = [];
  for (const T of TIERS) {
    for (let i = 0; i < PER_CHAPTER; i++) {
      const t0 = Date.now();
      const made = makePuzzle({ tier: T.idx, seed: seedOf(T.idx, i) });
      const m = made.meta;
      entries.push({
        id: `c${T.idx}p${i}`,
        chapter: T.idx,
        index: i,
        tier: T.idx,
        tierName: T.name,
        code: made.code,
        ink: rleEncode(made.solution),
        cells: m.cells,
        clues: m.clues,
        runs: m.runs,
        maxRun: m.maxRun,
        score: m.score,
        steps: m.steps,
        prunes: m.prunes,
        rounds: m.rounds,
        combos: m.combos,
        depth: m.depth,
        regionUsed: m.regionUsed,
        regionNeeded: m.needsRegion,
        countNodes: m.countNodes,
        overbudget: m.overbudget,
        rules: Object.keys(m.breakdown).sort().join('+'),
        genMs: Date.now() - t0,
      });
      console.log(
        `  ${T.name} 第${i + 1}局 ${made.code.w}×${made.code.h} 白格 ${m.cells} 线索 ${m.clues} ` +
          `分数 ${m.score} 步 ${m.steps} 消去 ${m.prunes} 进差法 ${m.regionUsed ? '用' : '不用'}` +
          `${m.needsRegion ? '（不用推不完）' : ''} 雕 ${m.carved} 格 抽 ${m.attempts} 次 ` +
          `穷举 ${m.countNodes}/${m.countBudget} 节点 超预算 ${m.overbudget} ${Date.now() - t0}ms`,
      );
    }
    tierLine(T, entries.filter((e) => e.chapter === T.idx));
  }
  return entries;
}

/** 逐档打印的穷举预算账：这一档出货的局里有多少局"唯一解没证完"。必须为 0。 */
function tierLine(T, list) {
  const over = list.filter((e) => e.overbudget).length;
  const worst = list.reduce((a, e) => Math.max(a, e.countNodes), 0);
  console.log(
    `  ── ${T.name}：出货 ${list.length} 局｜超预算 ${over} 局（穷举节点最多用到 ${worst}/${DEFAULT_MAX_NODES}）`,
  );
  return { over, worst, n: list.length };
}

function totals(entries) {
  const sum = (k) => entries.reduce((a, e) => a + e[k], 0);
  return {
    version: 1,
    generator: 'kakuro/1',
    perChapter: PER_CHAPTER,
    puzzles: entries.length,
    chapters: TIERS.length,
    cells: sum('cells'),
    clues: sum('clues'),
    inkChars: sum('ink') && entries.reduce((a, e) => a + e.ink.length, 0),
    minScore: Math.min(...entries.map((e) => e.score)),
    maxScore: Math.max(...entries.map((e) => e.score)),
    regionBoards: entries.filter((e) => e.regionUsed).length,
    neededBoards: entries.filter((e) => e.regionNeeded).length,
    overbudgetBoards: entries.filter((e) => e.overbudget).length,
    maxCountNodes: entries.reduce((a, e) => Math.max(a, e.countNodes), 0),
    countBudget: DEFAULT_MAX_NODES,
  };
}

function render(entries) {
  const head =
    '// 本文件由 tools/bake.mjs 生成，请勿手改。\n' +
    '//   重新生成：node tools/bake.mjs        重新校验：node tools/bake.mjs --check\n' +
    '// 每一局都在构建期被两支实现共同确认：solve() 的铅笔路径推得完，count.js 穷举数到恰好一个解，\n' +
    '// 两边的解逐格相同。ink 是答案的 RLE（按白格密集下标），--check 拿它跟现推的解比对。\n';
  const body = entries
    .map((e) =>
      '  ' +
      JSON.stringify({
        id: e.id,
        chapter: e.chapter,
        index: e.index,
        tier: e.tier,
        tierName: e.tierName,
        code: e.code,
        ink: e.ink,
        cells: e.cells,
        clues: e.clues,
        runs: e.runs,
        maxRun: e.maxRun,
        score: e.score,
        steps: e.steps,
        prunes: e.prunes,
        rounds: e.rounds,
        combos: e.combos,
        depth: e.depth,
        regionUsed: e.regionUsed,
        regionNeeded: e.regionNeeded,
        countNodes: e.countNodes,
        overbudget: e.overbudget,
        rules: e.rules,
      }),
    )
    .join(',\n');
  return `${head}export const BAKE = ${JSON.stringify(totals(entries))};\n\nexport const LEVELS = [\n${body},\n];\n`;
}

// ---- 校验：只读文件里的线索串，把答案重新推一遍 ----------------------------------------------

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

async function check() {
  const text = readFileSync(OUT, 'utf8');
  const mod = await import(`file://${OUT}?bakecheck=${Date.now()}`);
  const entries = mod.LEVELS;
  console.log(`读入 ${entries.length} 局，BAKE = ${JSON.stringify(mod.BAKE)}`);
  for (const e of entries) {
    const label = `${e.id}（${e.tierName} 第${e.index + 1}局 ${e.code.w}×${e.code.h}）`;
    let board;
    try {
      board = decodePuzzle(e.code);
    } catch (err) {
      fail(`${label} 解码失败：${err.message}`);
      continue;
    }
    const res = solve(board);
    if (!res.ok) {
      fail(`${label} 铅笔推不完：${res.conflict || `停在 ${res.filled}/${board.n} 格`}`);
      continue;
    }
    if (!complete(board, res.values)) fail(`${label} complete() 判否`);
    const bad = verify(board, res.values);
    if (bad.length) fail(`${label} 独立验收报错：${JSON.stringify(bad[0])}`);
    const cnt = countSolutions(board);
    if (cnt.status === OVERBUDGET) {
      // 这一条单独喊：不是"多解"，是"没数完"。没证完唯一解的局一律不出货。
      e.overbudget = 1;
      fail(`${label} 穷举超预算：${cnt.nodes} 节点用完仍未数完，唯一解没证完（要出货只能加预算或缩小该档盘）`);
    } else if (cnt.status !== UNIQUE) {
      e.overbudget = 0;
      fail(`${label} 穷举解数 ${cnt.count}（status=${cnt.status}），唯一解承诺不成立`);
    } else e.overbudget = 0;
    e.countNodes = cnt.nodes;
    const diff = diffCells(board, res.values, cnt.values);
    if (diff.length) fail(`${label} 两支实现的解在第 ${diff[0] + 1} 格不一致`);
    const ink = rleEncode(res.values);
    if (ink !== e.ink) fail(`${label} 烘进去的答案与现推不一致（RLE 不同）`);
    const m = measure(board);
    for (const [k, v] of [
      ['score', m.score],
      ['steps', m.steps],
      ['prunes', m.prunes],
      ['rounds', m.rounds],
      ['combos', m.combos],
      ['cells', m.cells],
      ['clues', m.clues],
      ['regionUsed', m.regionUsed],
      ['regionNeeded', m.needsRegion],
    ]) {
      if (e[k] !== v) fail(`${label} 读数 ${k}：文件写 ${e[k]}，现算 ${v}`);
    }
    const T = TIERS[e.tier];
    if (e.score < T.band[0] || e.score > T.band[1]) fail(`${label} 分数 ${e.score} 出 band ${JSON.stringify(T.band)}`);
    if (T.regionMode === 'needed' && !m.needsRegion) fail(`${label} 「${T.name}」要求不用进差法就推不完，实际不用也推得完`);
    if (T.regionMode === 'off' && m.regionUsed) fail(`${label} 「${T.name}」要求不碰进差法，实际用了`);
    if (puzzleId(e.code) !== `${e.code.w}x${e.code.h}:${e.code.bl}:${e.code.ac}:${e.code.dn}`) fail(`${label} id 与编码不符`);
    if (WANT_REDUNDANT && e.tier <= 1) {
      // 只打数、不 fail：2026-09-27 实测 25 局 619 条线索里 618 条可省，而"每条线索都承重"从来不是承诺。
      // fail 只留给 unproven —— 那是"这次测量没做完"，不是"这条必要"。
      const rep = redundantClues(board);
      if (rep.redundant.length) {
        console.log(`  · ${label} 可省线索 ${rep.redundant.length}/${rep.runs} 条（过约束，不影响唯一解判定）`);
      }
      if (rep.unproven.length) {
        fail(`${label} 有 ${rep.unproven.length} 条线索的"能不能省"没数完（预算内 OVERBUDGET），不能声称它必要`);
      }
    }
  }
  // 逐档打账：出货的每一局都要在预算内被穷举确认唯一，`超预算` 为 0 才算这一档成立
  console.log('');
  for (const T of TIERS) {
    const list = entries.filter((e) => e.chapter === T.idx);
    if (list.length) tierLine(T, list);
  }
  console.log('');
  if (!failures) ok(`${entries.length} 局全部：铅笔推得完 + 穷举唯一（超预算 0 局）+ 两边逐格相同 + 读数复算相等`);
  const rebuilt = render(entries.map((e) => ({ ...e, genMs: 0 })));
  if (rebuilt !== text) {
    const a = text.split('\n');
    const b = rebuilt.split('\n');
    let at = a.findIndex((line, i) => line !== b[i]);
    if (at < 0) at = Math.max(a.length, b.length) - 1;
    fail(`文件文本与重新序列化的结果不同（第 ${at + 1} 行起）。是不是手改了 levels.js？`);
    console.log(`    文件：${(a[at] || '').slice(0, 120)}`);
    console.log(`    应为：${(b[at] || '').slice(0, 120)}`);
  } else if (!failures) {
    ok('文件文本逐字节可比对结果一致');
  }
}

// ---- 入口 ------------------------------------------------------------------------------------

if (CHECK) {
  console.log('bake --check：从线索串重推答案，不跑生成器');
  await check();
  if (WANT_REDUNDANT) console.log('  （REDUNDANT=1：已对轻档逐条线索做"能不能省"实测）');
  if (failures) {
    console.log(`✗ bake --check 失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('✓ bake --check 全绿');
} else {
  console.log(`bake：每章 ${PER_CHAPTER} 局 × ${TIERS.length} 章，开始生成（慢档每局几十秒）`);
  const entries = buildEntries();
  const text = render(entries);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text, 'utf8');
  console.log(`写出 ${OUT} （${(text.length / 1024).toFixed(1)} KB，${entries.length} 局）`);
  console.log(`BAKE = ${JSON.stringify(totals(entries))}`);
  console.log('接着跑一遍自校验：');
  await check();
  if (failures) {
    console.log(`✗ 刚写出的文件自校验失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('✓ bake 完成并自校验通过');
}
