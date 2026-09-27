// 出题器：先种答案，再让线索自己长出来。
//
// 为什么是"答案优先"（solution-first）而不是"给线索再删线索"：
//   加算十字的每条 run 恰好带一条线索（规则 1），删掉它那条 run 就只剩"互不重复"约束。
//   所以传统"雕刻 + 逐条删线索"的套路在这里没有对应的操作空间 —— 能雕的是**结构**。
//   于是我们把自由度全放在黑格图样上：
//     ① 先随机一个黑格图样（第 1 行第 1 列必须全黑：每条 run 都得有人写它的和）
//     ② 按扫描序往白格里种数字，种的时候就把"同 run 不重复"当硬约束（规则 2 由构造成立）
//     ③ 线索 = 每条 run 的数字和 ⇒ 规则 3（线索落在 [minSum(L), maxSum(L)] 内）自动成立，
//        因为它本来就是 L 个互不相同的 1..9 数字之和
//     ④ 拿铅笔路径 solve() 跑一遍，推不完就整盘丢掉；再拿 count.js 穷举数解，不唯一也丢掉
//   每一步都在**重跑铅笔路径**，这正是规范要的"雕刻后确认还能推到底"，只是这里的刀是图样不是线索。
//   （"某条线索能不能省"没靠嘴说，是量出来的：见 redundantClues() 与 balance 的 `冗余线索` 一列 ——
//    把那条 run 的和擦成未知，让 count.js 重新数解，仍唯一才算冗余。实测 0 条。）
//
// 难度的三个旋钮：盘尺寸、白格密度（决定 run 的长度分布）、**要不要动用进差法**。
// 三个都是从 solve()/count.js 量出来的读数，不是拍脑袋贴的标签；分位表在 tools/balance.mjs。

import {
  ACROSS,
  DOWN,
  MAX_DIGIT,
  createBoard,
  decodeColumn,
  encodeBoard,
  solve,
  verify,
} from './kakuro.js';
import { clueLegal, countCombinations, maxSum, minSum } from './combos.js';
import { DEFAULT_MAX_NODES, OVERBUDGET, UNIQUE, buildRuns, countSolutions, diffCells, toDense } from './count.js';
import { dateSeed, mix } from './rng.js';

const BLACK = 1;
const NO_CLUE = 0;

// ---- 结构 ------------------------------------------------------------------------------------

/**
 * 一张黑格图样合不合式：第 1 行第 1 列全黑、每条内圈行列至少有一个白格、没有超过 9 格的 run。
 * 返回 { maxLen } 或 null。
 */
export function checkStructure(w, h, black) {
  let maxLen = 0;
  for (let r = 1; r < h; r++) {
    let any = false;
    let run = 0;
    for (let c = 1; c < w; c++) {
      if (black[r * w + c]) {
        if (run > maxLen) maxLen = run;
        run = 0;
      } else {
        any = true;
        run++;
      }
    }
    if (run > maxLen) maxLen = run;
    if (!any) return null;
  }
  for (let c = 1; c < w; c++) {
    let any = false;
    let run = 0;
    for (let r = 1; r < h; r++) {
      if (black[r * w + c]) {
        if (run > maxLen) maxLen = run;
        run = 0;
      } else {
        any = true;
        run++;
      }
    }
    if (run > maxLen) maxLen = run;
    if (!any) return null;
  }
  if (maxLen > MAX_DIGIT) return null;
  return { maxLen };
}

/** 随机一个黑格图样（行 0 / 列 0 全黑，其余按密度撒）。不合式返回 null，另抽。 */
export function sampleStructure(w, h, rand, density) {
  const black = new Uint8Array(w * h);
  for (let c = 0; c < w; c++) black[c] = BLACK;
  for (let r = 0; r < h; r++) black[r * w] = BLACK;
  for (let r = 1; r < h; r++) {
    for (let c = 1; c < w; c++) if (rand() < density) black[r * w + c] = BLACK;
  }
  const st = checkStructure(w, h, black);
  return st ? { black, ...st } : null;
}

/**
 * 往白格里种数字：扫描序逐格选，选的时候禁掉"这条 run 里已经用过的数"。
 * 于是规则 2 由构造保证，规则 3 也一起保证（和必然是 L 个不同数字之和）。
 * 选不出数返回 null（长 run 交叉多了会撞上），换一张图样。
 */
export function plantDigits(w, h, black, rand) {
  const values = new Uint8Array(w * h);
  const acrossUsed = new Map();
  const downUsed = new Map();
  for (let r = 1; r < h; r++) {
    for (let c = 1; c < w; c++) {
      const t = r * w + c;
      if (black[t]) continue;
      const au = acrossUsed.get(r) || new Set();
      const du = downUsed.get(c) || new Set();
      const choices = [];
      for (let d = 1; d <= MAX_DIGIT; d++) if (!au.has(d) && !du.has(d)) choices.push(d);
      if (!choices.length) return null;
      const pick = choices[Math.floor(rand() * choices.length)];
      values[t] = pick;
      au.add(pick);
      du.add(pick);
      acrossUsed.set(r, au);
      downUsed.set(c, du);
    }
  }
  return values;
}

/** 由种好的数字算出两条方向的和，写回各 run 的黑格家里。线索不是"给"的，是**长**出来的。 */
export function cluesOf(w, h, black, values) {
  const across = new Int8Array(w * h);
  const down = new Int8Array(w * h);
  const isBlack = (r, c) => black[r * w + c] === BLACK;
  for (let r = 1; r < h; r++) {
    let c = 1;
    while (c < w) {
      if (isBlack(r, c)) {
        c++;
        continue;
      }
      const start = c;
      let s = 0;
      while (c < w && !isBlack(r, c)) {
        s += values[r * w + c];
        c++;
      }
      across[r * w + start - 1] = s;
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
      let s = 0;
      while (r < h && !isBlack(r, c)) {
        s += values[r * w + c];
        r++;
      }
      down[(start - 1) * w + c] = s;
    }
  }
  return { across, down };
}

/** 结构 + 种下的数字 → 建好的盘（线索现算；雕空的行列会被 checkStructure 判死）。 */
export function buildFrom(w, h, black, values) {
  const st = checkStructure(w, h, black);
  if (!st) return null;
  const { across, down } = cluesOf(w, h, black, values);
  let board;
  try {
    board = createBoard({ w, h, black, across, down });
  } catch (e) {
    // 线索由构造必然合法；真撞上了就是引擎缺陷，喊出来，别悄悄换一张
    if (/合法区间|超过 9/.test(e.message)) throw new Error(`种下的数字长出了非法线索：${e.message}`);
    throw e;
  }
  return board;
}

/** 抽一张候选盘：结构 + 种下的数字 + 建好的盘。结构不合式返回 null。 */
export function drawBoard(w, h, rand, density) {
  const st = sampleStructure(w, h, rand, density);
  if (!st) return null;
  const values = plantDigits(w, h, st.black, rand);
  if (!values) return null;
  const board = buildFrom(w, h, st.black, values);
  return { board, values, black: st.black };
}

// ---- 雕刻 ------------------------------------------------------------------------------------

/**
 * 挑一刀该雕在哪：铅笔推不完的那些格子里，选"卡住它的 run 最含糊"的那一格。
 * 含糊度直接用 C(L,S) —— 组合清单有几条，就是这张铅笔标记有几格能填。
 */
function pickVictim(board, m, rand) {
  const stuck = m.values ? board.whites.filter((t) => !m.values[t]) : [];
  const pool = stuck.length ? stuck : board.whites.slice();
  if (!pool.length) return -1;
  let bestScore = -1;
  const cands = [];
  for (const t of pool) {
    const a = board.runs[board.acrossRun[t]];
    const d = board.runs[board.downRun[t]];
    const s = countCombinations(a.len, a.clue) + countCombinations(d.len, d.clue);
    if (s > bestScore) {
      bestScore = s;
      cands.length = 0;
      cands.push(t);
    } else if (s === bestScore) {
      cands.push(t);
    }
  }
  return cands[Math.floor(rand() * cands.length)];
}

/**
 * 雕刻：铅笔推不完时，把一个白格改成黑格（两条 run 一起变短、线索一起变小），**重算线索、
 * 重跑一遍完整的铅笔路径**。这就是规范 §1 要的"每一步雕刻都要重跑铅笔确认还能推到底"——
 * 加算十字删不掉线索（每条 run 恰好一条），能删的是格子。
 * 每雕一刀都让盘更"碎"，所以刀数就是难度上限的调节器：大盘想用几刀换来确定可推。
 *
 * regionMode：
 *   'off'    推导脚本里一次都不许动用进差法（低档：只靠组合清单就该推完）
 *   'allow'  不管
 *   'needed' 必须**不用进差法就推不完、用了才推得完**（solve({regions:false}) 停在半路）
 */
export function carveToSolvable(w, h, black, values, rand, { maxCarves = 0, regionMode = 'allow' } = {}) {
  let bl = Uint8Array.from(black);
  for (let step = 0; step <= maxCarves; step++) {
    const board = buildFrom(w, h, bl, values);
    if (!board) return null; // 雕到整行整列全黑了，这株不要
    const m = measure(board);
    if (m.ok && regionAllows(m, regionMode)) {
      return { board, black: Uint8Array.from(bl), values: Uint8Array.from(values), carved: step, measure: m };
    }
    if (step === maxCarves) return null;
    const victim = pickVictim(board, m, rand);
    if (victim < 0) return null;
    bl = Uint8Array.from(bl);
    bl[victim] = BLACK;
  }
  return null;
}

export function regionAllows(m, regionMode) {
  if (regionMode === 'off') return !m.regionUsed;
  if (regionMode === 'needed') return m.needsRegion === 1;
  return true;
}

/** 便捷入口：随便抽一张能推到底的盘（测试和演示用，不带档位分数要求）。 */
export function randomSolvable(w, h, { density = 0.42, seed = 1, maxAttempts = 20000, maxCarves = 0, maxNodes = DEFAULT_MAX_NODES } = {}) {
  const rand = mix(`${w}:${h}:${density}:${seed}`);
  let overbudget = 0;
  for (let i = 0; i < maxAttempts; i++) {
    const st = sampleStructure(w, h, rand, density);
    if (!st) continue;
    const values = plantDigits(w, h, st.black, rand);
    if (!values) continue;
    const res = carveToSolvable(w, h, st.black, values, rand, { maxCarves });
    if (!res) continue;
    const a = audit(res.board, undefined, { maxNodes });
    if (a.ok) return { ...res, ...a, attempts: i + 1, overbudget };
    if (a.overbudget) overbudget++; // 唯一解没证完的盘照样拒收，只是这个数要能被人看见
  }
  throw new Error(`${w}×${h} 抽了 ${maxAttempts} 次没抽到可推到底的唯一盘（其中 ${overbudget} 次是穷举超预算）`);
}

// ---- 难度 ------------------------------------------------------------------------------------

/** 一次推导的全部读数。分数/步数/用到的规则/要不要进差法，全在这里，别处不再算第二遍。 */
export function measure(board) {
  const full = solve(board);
  if (full.conflict) {
    // 这张盘的解是种下去的，铅笔却判矛盾 ⇒ 某条规则不保险了。这是最严重的一类缺陷，直接炸。
    throw new Error(`规则可靠性缺陷：种有解的盘被判矛盾 —— ${full.conflict}`);
  }
  const weak = solve(board, { regions: false });
  const combos = board.runs.reduce((s, run) => s + countCombinations(run.len, run.clue), 0);
  const worst = board.runs.reduce((s, run) => Math.max(s, countCombinations(run.len, run.clue)), 0);
  return {
    ok: full.ok,
    conflict: full.conflict,
    score: full.score,
    steps: full.places,
    prunes: full.prunes,
    rounds: full.rounds,
    depth: full.depth,
    breakdown: full.breakdown,
    needsRegion: full.ok && !weak.ok ? 1 : 0,
    regionUsed: full.regionUsed ? 1 : 0,
    cells: board.n,
    runs: board.runs.length,
    clues: board.clues,
    maxRun: board.runs.reduce((s, run) => Math.max(s, run.len), 0),
    combos,
    worstCombos: worst,
    density: board.n / ((board.w - 1) * (board.h - 1)),
    events: full.events,
    values: full.values,
  };
}

/**
 * 五档。四个旋钮：盘尺寸、黑格密度、最多雕几刀、进差法的要求。
 *
 *   regionMode 'off'    —— 推导脚本一次都不许动用进差法（低档必须只靠组合清单推完）
 *   regionMode 'allow'  —— 不管用不用
 *   regionMode 'needed' —— **不用进差法就推不完、用了才推得完**（solve({regions:false}) 停在半路）
 *
 * band 不是愿望，是**测量结果**：先跑分位表，再把实测区间填进来，tools/balance.mjs 拿它当门禁。
 * maxAttempts 是"抽多少张图样还抽不到就认输"的上限；抽不到直接抛错，绝不放宽验收。
 * live=false 的档现场生成要几十秒（'needed' 这一条件在 8×8 上约 3700 抽才中一次），
 * 所以这两档的题由 tools/bake.mjs 在构建期烘进 js/data/levels.js，界面只读不生成。
 */
export const TIERS = [
  {
    idx: 0,
    key: 'warmup',
    name: '入门',
    w: 5,
    h: 5,
    density: 0.5,
    maxCarves: 0,
    regionMode: 'off',
    band: [10, 30],
    maxAttempts: 6000,
    live: true,
    blurb: '小盘短 run，组合清单基本直接给答案',
  },
  {
    idx: 1,
    key: 'easy',
    name: '简单',
    w: 6,
    h: 6,
    density: 0.46,
    maxCarves: 0,
    regionMode: 'off',
    band: [18, 50],
    maxAttempts: 8000,
    live: true,
    blurb: '交叉消去开始吃紧，进差法还派不上用场',
  },
  {
    idx: 2,
    key: 'mid',
    name: '中等',
    w: 7,
    h: 7,
    density: 0.4,
    maxCarves: 1,
    regionMode: 'allow',
    band: [30, 85],
    maxAttempts: 9000,
    live: true,
    blurb: '长 run 多了，逼着你在两条 run 之间来回消候选',
  },
  {
    idx: 3,
    key: 'hard',
    name: '难',
    w: 8,
    h: 8,
    density: 0.36,
    maxCarves: 2,
    regionMode: 'needed',
    band: [70, 180],
    maxAttempts: 24000,
    live: false,
    blurb: '不用进差法就推不完：整片行列的和之差才给得出新候选',
  },
  {
    idx: 4,
    key: 'expert',
    name: '烧脑',
    w: 10,
    h: 10,
    density: 0.3,
    maxCarves: 6,
    regionMode: 'allow',
    band: [110, 240],
    maxAttempts: 9000,
    live: false,
    blurb: '大盘长 run，步数和候选枚举量都是五档里最高的',
  },
];

export const MAX_TIER = TIERS.length - 1;

export function tierFor(idx) {
  return TIERS[Math.max(0, Math.min(MAX_TIER, idx | 0))];
}

/**
 * 唯一性 + 一致性的完整体检。出货与 bake 只认这个函数说的 yes。
 * 三件事必须同时成立：铅笔推得完、穷举只数出一个解、两边的解**逐格相同**。
 *
 * 第四种情形要单独分开说，因为它不是"缺陷"而是"没证完"：穷举的节点预算用完（OVERBUDGET）。
 * 这一局同样**拒收**，但拒收的理由要写对 —— 前者要去改规则，后者只许去加预算或缩小该档盘面。
 * 返回 { ok:false, overbudget:true } 让调用方把它计入 `超预算`，绝不静悄悄当唯一解出货。
 */
export function audit(board, known, { maxNodes = DEFAULT_MAX_NODES } = {}) {
  const res = solve(board);
  if (!res.ok) return { ok: false, why: res.conflict || `铅笔停在 ${res.filled}/${board.n} 格` };
  const bad = verify(board, res.values);
  if (bad.length) return { ok: false, why: `铅笔的解过不了独立验收：${JSON.stringify(bad[0])}` };
  const cnt = countSolutions(board, { maxNodes });
  if (cnt.status === OVERBUDGET) {
    return {
      ok: false,
      overbudget: true,
      nodes: cnt.nodes,
      budget: cnt.budget,
      why: `穷举到 ${cnt.nodes} 节点（预算 ${cnt.budget}）还没数完，唯一解没证完`,
    };
  }
  if (cnt.status !== UNIQUE) {
    return { ok: false, why: `穷举数出 ${cnt.count} 个解（status=${cnt.status}），不唯一` };
  }
  const diff = diffCells(board, res.values, cnt.values);
  if (diff.length) {
    return { ok: false, why: `两套实现给出的唯一解在第 ${diff[0] + 1} 格不一致` };
  }
  return {
    ok: true,
    solution: res.values,
    gridSolution: cnt.values,
    denseFromCount: toDense(board, cnt.values),
    measure: known || measure(board),
    nodes: cnt.nodes,
    budget: cnt.budget,
    overbudget: 0,
  };
}

/**
 * "这条线索能不能省"的实测：把某条 run 的和擦成未知（规则 2 仍然生效），重新穷举数解。
 * 仍唯一 ⇒ 那条线索多余。
 *
 * 实测口径（2026-09-27，25 局 619 条线索）：**每一局的每一条线索都是可省的** ——
 * 618 条在 200k 节点内证完可省，1 条没数完（`unproven`），被量出"非省不可"的 0 条。
 * 原因是 solution-first 出题把所有 run 的和都写上了，雕刻每局只抹 0~1 条。
 * 这不打破任何承诺：本仓承诺的是"每一局唯一解在预算内证完 + 铅笔推得完 + 两套实现逐格相同"
 * （engine-test 的 E/F/G 三节逐格量），**从来没有**承诺过"每一条线索都是承重墙"。
 * 上一版注释写的是"几乎不该出现，出现了就说明结构有问题"——那是一句没测过的话，被自己的数据推翻。
 * 反过来说，这条数据能证明的是：谁哪天把"线索最小"当成承诺，就必须让 redundant 掉到 0，
 * 而 `unproven` 在预算内没数完时**不许**当成"必要"（要下结论只能加预算重跑）。
 *
 * 返回三个数，缺一个都不算说清楚：
 *   redundant —— 实测可省的线索
 *   unproven  —— 预算内没数完，因此**不能声称**这条必要（要下结论只能加预算重跑）
 *   runs      —— 探过的线索条数
 */
export function redundantClues(board, { maxNodes = 200_000 } = {}) {
  const own = buildRuns(board);
  const redundant = [];
  const unproven = [];
  for (const run of own) {
    const cnt = countSolutions(board, { limit: 2, maxNodes, ignore: [run.id] });
    const twin = board.runs.find((r) => r.home === run.home && r.dir === run.dir);
    const rec = { home: run.home, dir: run.dir, status: cnt.status, nodes: cnt.nodes, where: twin ? twin.where : '?' };
    if (cnt.status === UNIQUE) redundant.push(rec);
    else if (cnt.status === OVERBUDGET) unproven.push(rec);
  }
  return { redundant, unproven, runs: own.length };
}

// ---- 出货 ------------------------------------------------------------------------------------

/**
 * 抽一张符合档位要求的盘。返回 { code, board, solution, meta }；抽不到直接抛，
 * 绝不"顺手放宽一点"——放宽标准等于把承诺作废（DESIGN §8）。
 *
 * meta.countNodes / countBudget / overbudget 是**穷举体检的账**：出货那一局必须是
 * overbudget=0（唯一解当场证完）。因预算耗尽而没证完的候选盘计入 budgetReject 后丢掉，
 * 这个数会随 balance 的分位表逐档打出来。
 */
export function makePuzzle(opts = {}) {
  const { tier = 0, seed = 1, maxNodes = DEFAULT_MAX_NODES } = opts;
  const T = tierFor(tier);
  const rand = mix(`${T.key}|${T.w}x${T.h}|${T.density}|${T.maxCarves}|${seed}`);
  let attempts = 0;
  let drawn = 0;
  let carveFail = 0;
  let bandFail = 0;
  let budgetReject = 0;
  let carved = 0;
  while (attempts < T.maxAttempts) {
    attempts++;
    const st = sampleStructure(T.w, T.h, rand, T.density);
    if (!st) continue;
    const values = plantDigits(T.w, T.h, st.black, rand);
    if (!values) continue;
    drawn++;
    const res = carveToSolvable(T.w, T.h, st.black, values, rand, {
      maxCarves: T.maxCarves,
      regionMode: T.regionMode,
    });
    if (!res) {
      carveFail++;
      continue;
    }
    const m = res.measure;
    if (m.score < T.band[0] || m.score > T.band[1]) {
      bandFail++;
      continue;
    }
    const a = audit(res.board, m, { maxNodes });
    if (a.overbudget) {
      // 唯一解没证完 ⇒ 这一局不出货。丢掉、计数、继续抽；要出货只能加预算或缩小该档盘面。
      budgetReject++;
      continue;
    }
    if (!a.ok) throw new Error(`规则可靠性缺陷：铅笔推得完却过不了独立体检 —— ${a.why}`);
    carved += res.carved;
    const meta = {
      tier: T.idx,
      tierName: T.name,
      key: T.key,
      seed,
      attempts,
      drawn,
      pencilFail: carveFail,
      bandFail,
      budgetReject,
      carved: res.carved,
      w: T.w,
      h: T.h,
      ...m,
      nodes: a.nodes,
      countNodes: a.nodes,
      countBudget: a.budget,
      overbudget: a.overbudget,
    };
    return { code: encodeBoard(res.board), board: res.board, solution: a.solution, meta };
  }
  throw new Error(
    `档位「${T.name}」抽了 ${attempts} 张图样（结构合式 ${drawn}，推不完/进差法不合要求 ${carveFail}、` +
      `分数越界 ${bandFail}、穷举超预算 ${budgetReject}）仍没拿到 band ${T.band} 内的唯一可推盘 —— ` +
      `该加穷举预算、调密度或缩小该档盘尺寸，不该放宽验收。`,
  );
}

/** 从紧凑编码复原一盘（bake / 存档都走这条路，不走就复现不出来）。 */
export function decodePuzzle(code) {
  if (!code || typeof code.bl !== 'string') throw new Error('题目编码不完整');
  const { w, h } = code;
  if (!(w >= 3 && h >= 3)) throw new Error(`题目尺寸 ${w}×${h} 不合法`);
  return createBoard({
    w,
    h,
    black: decodeColumn(w, h, code.bl, '黑格表'),
    across: decodeColumn(w, h, code.ac, '横向和'),
    down: decodeColumn(w, h, code.dn, '纵向和'),
  });
}

/** 日课：同一天的所有人拿到同一张盘。种子只来自日期，绝不来自时钟。 */
export function dailyPuzzle(dateInput, tier = 2) {
  const { key, epochDays } = dateSeed(dateInput);
  const T = tierFor(tier);
  const made = makePuzzle({ tier, seed: 1000 + (epochDays % 99991) });
  return { ...made, day: key, tier: T.idx };
}

/** 一局的稳定标识：编码本身。两局编码相同就是同一局。 */
export function puzzleId(code) {
  return `${code.w}x${code.h}:${code.bl}:${code.ac}:${code.dn}`;
}

export { minSum, maxSum, clueLegal, ACROSS, DOWN, NO_CLUE };
