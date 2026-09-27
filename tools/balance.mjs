// 难度是不是量出来的？这个文件就是那把尺。
//
// 跑法：
//   node tools/balance.mjs                 # 每档抽 12 题（重档 4 题）
//   SAMPLES=24 node tools/balance.mjs      # 指定轻档样本数
//   SAMPLES_HEAVY=6 node tools/balance.mjs # 指定重档（难/烧脑）样本数
//
// 做四件事，任何一件不成立就 exit 1：
//   ① 每档打出分位表（分数 / 步数 / 候选消去数 / 白格数 / 组合枚举量 / 推导轮数）
//   ② 阶梯门禁：五档的中位数必须严格递增，且每道题的分数必须落在该档 band 内
//   ③ 承诺门禁：'off' 档的推导脚本一次都不许用进差法，'needed' 档必须**不用就推不完**；
//      每一题都要通过第二套实现的穷举（解唯一）并与铅笔的解逐格相同
//   ④ 独立对账：run 组合数表 C(L,S) 由动态规划算出，与穷举枚举逐位相等；再核三条恒等式
//
// 每一档另外单独打一行 `超预算 X/N`：X 是"穷举到预算用完还没数完解"的出货局数，**必须是 0**。
// 预算用完意味着唯一解根本没证完，这样的盘一律不出货（生成期就把整张盘丢掉并计入丢弃数）；
// 想让它变 0 只许加 COUNT_NODES / 收紧剪枝 / 缩小该档盘尺寸，不许把这行从输出里抹掉。
//
// 禁止为了跑绿去放宽 band、允许回溯、弱化断言 —— 见 DESIGN §8。

import {
  TIERS,
  makePuzzle,
  measure,
  redundantClues,
} from '../js/engine/generate.js';
import { countCombinations, enumerateCombos, maxSum, minSum, clueLegal } from '../js/engine/combos.js';
import { DEFAULT_MAX_NODES, OVERBUDGET, countSolutions, diffCells, UNIQUE } from '../js/engine/count.js';
import { solve, verify, complete } from '../js/engine/kakuro.js';

const SAMPLES = Number(process.env.SAMPLES || 12);
const SAMPLES_HEAVY = Number(process.env.SAMPLES_HEAVY || 4);
const TIER_ONLY = process.env.TIER !== undefined ? Number(process.env.TIER) : null;
// 穷举预算：只许往大调（COUNT_NODES=8000000），不许往小调 —— 预算用完就是"唯一解没证完"。
const MAX_NODES = Number(process.env.COUNT_NODES || DEFAULT_MAX_NODES);
if (!(MAX_NODES >= DEFAULT_MAX_NODES)) {
  console.log(`✗ COUNT_NODES=${MAX_NODES} 比默认预算 ${DEFAULT_MAX_NODES} 还小：那会把没证完唯一解的盘当成合格货。`);
  process.exit(1);
}

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

const pct = (sorted, q) => {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
};
const fmt = (x) => (typeof x === 'number' && Number.isFinite(x) ? (Number.isInteger(x) ? String(x) : x.toFixed(1)) : String(x));
const line = (cells, seps = '─') => cells.join('  ');

// ---- ④ 独立对账：C(L,S) 动态规划 vs 穷举 ------------------------------------------------------

function reconcile() {
  console.log('\n【对账】run 组合数表 C(L,S)：动态规划 vs 上穷举');
  let cells = 0;
  let bad = 0;
  let maxCount = 0;
  let argmax = '';
  for (let L = 1; L <= 9; L++) {
    for (let S = 1; S <= 45; S++) {
      const dp = countCombinations(L, S);
      const brute = enumerateCombos(L, S).length;
      cells++;
      if (dp !== brute) {
        bad++;
        if (bad <= 5) fail(`C(${L},${S}) 动态规划 ${dp} ≠ 穷举 ${brute}`);
      }
      if (dp > maxCount) {
        maxCount = dp;
        argmax = `C(${L},${S})`;
      }
      if (dp > 0 && !clueLegal(L, S)) fail(`C(${L},${S}) 有组合却判线索非法`);
      if (dp === 0 && clueLegal(L, S)) fail(`C(${L},${S}) 线索合法却一个组合都没有`);
    }
  }
  if (!bad) pass(`${cells} 个 (L,S) 组合全部逐位相等（最多 ${maxCount} 条，出现在 ${argmax}）`);

  let idBad = 0;
  for (let L = 1; L <= 9; L++) {
    let sum = 0;
    for (let S = minSum(L); S <= maxSum(L); S++) sum += countCombinations(L, S);
    const binom = (() => {
      let r = 1;
      for (let i = 0; i < L; i++) r = (r * (9 - i)) / (i + 1);
      return Math.round(r);
    })();
    if (sum !== binom) {
      idBad++;
      fail(`Σ_S C(${L},S) = ${sum}，应等于 C(9,${L}) = ${binom}`);
    }
    if (countCombinations(L, minSum(L)) !== 1 || countCombinations(L, maxSum(L)) !== 1) {
      idBad++;
      fail(`长度 ${L} 的和取到端点 ${minSum(L)}/${maxSum(L)} 时应当只有一种组合`);
    }
  }
  if (!idBad) pass('Σ_S C(L,S) = C(9,L) 与两端唯一组合，L=1..9 全部成立');
  return { cells, bad, idBad, maxCount, argmax };
}

// ---- ①②③ 每档抽样 ----------------------------------------------------------------------------

function sampleTier(T, n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const seed = 1000 + i * 7919 + T.idx * 31;
    const t0 = Date.now();
    const made = makePuzzle({ tier: T.idx, seed, maxNodes: MAX_NODES });
    const ms = Date.now() - t0;
    rows.push({ seed, ms, meta: made.meta, board: made.board, code: made.code });
  }
  return rows;
}

function checkPuzzle(T, row, label) {
  const { board, meta } = row;
  const res = solve(board);
  if (!res.ok) fail(`${label} 铅笔推不完：${res.conflict || '停在半路'}`);
  if (!complete(board, res.values)) fail(`${label} 铅笔的解过不了 complete()`);
  const bad = verify(board, res.values);
  if (bad.length) fail(`${label} 独立验收报错：${JSON.stringify(bad[0])}`);
  const cnt = countSolutions(board, { maxNodes: MAX_NODES });
  // 这一行是"独立"的：它不看生成器怎么说，自己再拿穷举数一遍，预算账也自己记一遍
  row.overbudget = cnt.status === OVERBUDGET ? 1 : 0;
  row.countNodes = cnt.nodes;
  if (cnt.status === OVERBUDGET) {
    fail(`${label} 穷举超预算：${cnt.nodes} 节点用完还没数完，唯一解没证完（只许加 COUNT_NODES 或缩小该档盘）`);
  } else if (cnt.status !== UNIQUE) {
    fail(`${label} 穷举解数 ${cnt.count}（status=${cnt.status}），不是唯一解`);
  } else if (diffCells(board, res.values, cnt.values).length) fail(`${label} 两套实现的解逐格比对不一致`);
  if (meta.overbudget) fail(`${label} 生成器就报了穷举超预算，这样的盘不该出现在样本里`);
  if (meta.score < T.band[0] || meta.score > T.band[1]) {
    fail(`${label} 分数 ${meta.score} 落在 band ${JSON.stringify(T.band)} 之外`);
  }
  if (T.regionMode === 'off' && meta.regionUsed) fail(`${label} 「${T.name}」要求不用进差法，实测却用了`);
  if (T.regionMode === 'needed' && !meta.needsRegion) fail(`${label} 「${T.name}」要求不用进差法就推不完，实测不用也能推完`);
  if (T.regionMode === 'needed' && !meta.regionUsed) fail(`${label} needsRegion=1 却没记录进差法事件`);
  for (const run of board.runs) {
    if (!clueLegal(run.len, run.clue)) fail(`${label} ${run.where} 线索越界（规则 3）`);
    if (run.len > 9) fail(`${label} ${run.where} 长度 ${run.len} > 9（规则 3）`);
  }
  let sumA = 0;
  let sumD = 0;
  for (let i = 0; i < board.w * board.h; i++) {
    sumA += board.across[i];
    sumD += board.down[i];
  }
  if (sumA !== sumD) fail(`${label} 横向线索总和 ${sumA} ≠ 纵向线索总和 ${sumD}（同一批白格算两次，必须相等）`);
  return res;
}

function table(T, rows) {
  const sorted = (key) => rows.map((r) => r.meta[key]).sort((a, b) => a - b);
  const score = sorted('score');
  const steps = sorted('steps');
  const prunes = sorted('prunes');
  const cells = sorted('cells');
  const combos = sorted('combos');
  const rounds = sorted('rounds');
  const clues = sorted('clues');
  const maxRun = sorted('maxRun');
  const gen = rows.map((r) => r.ms).sort((a, b) => a - b);
  const need = rows.filter((r) => r.meta.needsRegion).length;
  const used = rows.filter((r) => r.meta.regionUsed).length;
  const atDraw = rows.reduce((s, r) => s + r.meta.drawn, 0);
  const atAttempt = rows.reduce((s, r) => s + r.meta.attempts, 0);
  const carved = rows.reduce((s, r) => s + r.meta.carved, 0);
  // 出货判据的账：抽题期因"唯一解没证完"被丢掉的盘 + 样本里没证完的盘 + 实际用掉的穷举节点
  const budgetReject = rows.reduce((s, r) => s + (r.meta.budgetReject || 0), 0);
  const over = rows.filter((r) => r.overbudget || r.meta.overbudget).length;
  const worstNodes = rows.reduce((s, r) => Math.max(s, r.countNodes || 0), 0);
  const q = (a) => `${fmt(pct(a, 0))} / ${fmt(pct(a, 0.25))} / ${fmt(pct(a, 0.5))} / ${fmt(pct(a, 0.75))} / ${fmt(pct(a, 1))}`;
  console.log(`\n【${T.name}】${T.w}×${T.h} 密度 ${T.density} 刀数 ≤${T.maxCarves} 进差法 ${T.regionMode} band ${JSON.stringify(T.band)}  n=${rows.length}`);
  console.log(`  分数  min/p25/p50/p75/max  ${q(score)}`);
  console.log(`  步数  min/p25/p50/p75/max  ${q(steps)}`);
  console.log(`  消去  min/p25/p50/p75/max  ${q(prunes)}`);
  console.log(`  白格  min/p25/p50/p75/max  ${q(cells)}    线索 ${q(clues)}    最长 run ${maxRun[0]}~${maxRun[maxRun.length - 1]}`);
  console.log(`  枚举  min/p25/p50/p75/max  ${q(combos)}   轮数 ${q(rounds)}`);
  console.log(`  进差法：用到 ${used}/${rows.length}，不用就推不完 ${need}/${rows.length}｜抽图 ${atAttempt}（合式 ${atDraw}）｜雕格 ${carved}`);
  console.log(
    `  超预算 ${over}/${rows.length}（出货的盘里唯一解没证完的）｜抽题期丢弃 ${budgetReject} 张超预算盘｜` +
      `穷举节点最多 ${worstNodes}/${MAX_NODES}`,
  );
  if (over) fail(`${T.name} 有 ${over} 局的唯一解没在预算内证完 —— 这一档不能出货`);
  console.log(`  生成耗时 ms p50 ${fmt(pct(gen, 0.5))} / max ${fmt(gen[gen.length - 1])}`);
  return { median: pct(score, 0.5), min: pct(score, 0), max: pct(score, 1), p25: pct(score, 0.25), p75: pct(score, 0.75), over, budgetReject };
}

function ladder(summaries) {
  console.log('\n【阶梯门禁】');
  let bad = 0;
  for (let i = 1; i < summaries.length; i++) {
    const a = summaries[i - 1];
    const b = summaries[i];
    if (!(b.median > a.median)) {
      bad++;
      fail(`${b.name} 中位数 ${fmt(b.median)} 没有高于 ${a.name} 的 ${fmt(a.median)}`);
    }
    if (b.min <= a.median && b.name !== a.name) {
      console.log(`  · 提醒：${b.name} 最易的一题（${fmt(b.min)}）比 ${a.name} 的中位数（${fmt(a.median)}）还轻 —— 档间有重叠，不算失败`);
    }
  }
  if (!bad) pass(`五档中位数严格递增：${summaries.map((s) => fmt(s.median)).join(' < ')}`);
  return bad;
}

async function main() {
  console.log(line(['加算十字 · 难度标定', `SAMPLES=${SAMPLES}`, `SAMPLES_HEAVY=${SAMPLES_HEAVY}`, `node ${process.version}`], ' '));
  const rec = reconcile();
  const summaries = [];
  for (const T of TIERS) {
    if (TIER_ONLY !== null && T.idx !== TIER_ONLY) continue;
    const n = T.live ? SAMPLES : Math.min(SAMPLES_HEAVY, SAMPLES);
    const t0 = Date.now();
    let rows;
    try {
      rows = sampleTier(T, n);
    } catch (e) {
      fail(`档位「${T.name}」生成失败：${e.message}`);
      continue;
    }
    console.log(`\n（${T.name} 抽 ${rows.length} 题用了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
    rows.forEach((row, i) => checkPuzzle(T, row, `${T.name} #${i + 1}`));
    summaries.push({ name: T.name, ...table(T, rows) });
  }
  if (summaries.length >= 2) ladder(summaries);

  // 冗余线索实测（REDUNDANT=1 才跑，默认关、CI 不开）：把一条 run 的和擦成未知之后还唯一，就说明那条线索可省。
  // 2026-09-27 实测：库里 25 局 619 条线索，618 条可省、被量出"非省不可"的 0 条 —— 因为 solution-first
  // 出题把所有 run 的和都写上，雕刻每局只抹 0~1 条。**"线索最小"从来不是本仓的承诺**（承诺是唯一解在预算内
  // 证完 + 铅笔推得完 + 两套实现逐格相同），所以这里只打数，不因"可省"而 fail。
  // 仍然 fail 的是 `unproven`：那不是"这条必要"，而是"这次测量没做完"，不下结论就得加预算重跑。
  if (process.env.REDUNDANT) {
    console.log('\n【冗余线索实测】');
    for (const T of TIERS) {
      if (!T.live) continue;
      const made = makePuzzle({ tier: T.idx, seed: 4242, maxNodes: MAX_NODES });
      const rep = redundantClues(made.board, { maxNodes: Number(process.env.REDUNDANT_NODES || 200_000) });
      console.log(
        `  ${T.name}：${rep.runs} 条线索里可省 ${rep.redundant.length} 条、数不完 ${rep.unproven.length} 条` +
          `（数不完的那 ${rep.unproven.length} 条只能算"没证明必要"，要下结论得加 REDUNDANT_NODES 重跑）` +
          `｜可省≠违规：出货承诺是最小性之外的"唯一 + 零猜测"，见 generate.js redundantClues 注释`,
      );
      if (rep.unproven.length) fail(`${T.name} 有 ${rep.unproven.length} 条线索的冗余判定超预算，实测没做完`);
    }
  }

  console.log('');
  if (failures) {
    console.log(`✗ balance 失败 ${failures} 项`);
    process.exit(1);
  }
  const over = summaries.reduce((s, x) => s + x.over, 0);
  const rejected = summaries.reduce((s, x) => s + x.budgetReject, 0);
  console.log(
    `✓ balance 全绿：对账 ${rec.cells} 格 0 处不一致，${summaries.length} 档阶梯通过，` +
      `超预算 ${over} 局（抽题期丢弃 ${rejected} 张），预算 ${MAX_NODES} 节点`,
  );
}

await main();
