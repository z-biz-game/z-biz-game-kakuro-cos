// 第二套实现：逐格回溯的解数计数器。
//
// 这个文件和 kakuro.js **故意互不信任**：
//   * 不 import kakuro.js —— 自己重新扫一遍网格建 run 表，自己写一份"和校验"
//   * 不用组合清单 enumerateCombos，也不用任何推理规则（唯一组合/必含之数/占位排他/进差法都不认识）
//   * 它只做一件事：按行主序一格一格地试 1..9，试到撞墙就退回去试下一个数
// 于是它给出的"解"是穷举出来的，和 solve() 那支不猜的铅笔没有任何共同前提。两条路在同一批题上
// 逐格比对：如果组合清单的交集漏了某个合法填法，铅笔会推不出；如果计数器把非法填法算成解，逐格比对
// 会立刻把它和铅笔的产物对不上。两边各写一遍和校验（DESIGN §4 记录了这条纪律的由来）。
//
// 它同时是**唯一解的判据**：countSolutions(board, {limit:2}) 说"只有 1 个解"，出题才算合格。
// 注意方向：solve() 推得完 ⇒ 解唯一（因为每条规则都对所有解成立）；反过来不成立 —— 有些唯一解的盘
// 铅笔推不完，那正是 balance 要量的东西。

export const NONE = 0; // 无解
export const UNIQUE = 1; // 恰好一个解
export const MANY = 2; // 至少两个解（limit 到了就停）
export const OVERBUDGET = -1; // 节点数用完还没数完：结论未知，不许当成"唯一"

const MAX_DIGIT = 9;
const ACROSS = 0;
const DOWN = 1;

/**
 * 自己建 run 表：按网格重扫，返回 [{dir, cells:[网格下标], clue, len}]。
 * 这里不读 board.runs —— 那份表是 kakuro.js 的产物，复用就等于把它的缺陷继承过来。
 */
export function buildRuns(board) {
  const { w, h, black, across, down } = board;
  const isBlack = (r, c) => black[r * w + c] === 1;
  const runs = [];
  for (let r = 0; r < h; r++) {
    let c = 0;
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
      runs.push({ id: runs.length, dir: ACROSS, cells, clue: across[r * w + start - 1], len: cells.length, home: r * w + start - 1 });
    }
  }
  for (let c = 0; c < w; c++) {
    let r = 0;
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
      runs.push({ id: runs.length, dir: DOWN, cells, clue: down[(start - 1) * w + c], len: cells.length, home: (start - 1) * w + c });
    }
  }
  return runs;
}

// 剩下 left 个互不相同、且不在 used 里的数字，能凑出的最小/最大和。纯算术，不涉及组合清单。
function minRest(left, used) {
  let s = 0;
  let d = 1;
  for (let k = 0; k < left; k++) {
    while (d <= MAX_DIGIT && used.has(d)) d++;
    if (d > MAX_DIGIT) return Infinity;
    s += d;
    d++;
  }
  return s;
}

function maxRest(left, used) {
  let s = 0;
  let d = MAX_DIGIT;
  for (let k = 0; k < left; k++) {
    while (d >= 1 && used.has(d)) d--;
    if (d < 1) return -Infinity;
    s += d;
    d--;
  }
  return s;
}

/**
 * 数解。`limit` 是数到几个就收手（默认 2：判唯一只需要知道"不超过一个"）。
 * 返回 { status, count, values, nodes }：values 是**按网格下标**排的 Uint8Array（黑格为 0），
 * 第一个解；换算成引擎的密集下标请用下面的 toDense()，两边比对时也这么做。
 */
export function countSolutions(board, { limit = 2, maxNodes = 4_000_000 } = {}) {
  const { w, h, black } = board;
  const n = w * h;
  const runs = buildRuns(board);
  const whites = [];
  for (let t = 0; t < n; t++) if (!black[t]) whites.push(t);

  // 每格属于哪两条 run（自己的表）
  const cellRuns = Array.from({ length: n }, () => []);
  for (const run of runs) for (const t of run.cells) cellRuns[t].push(run);
  // 每格在它的 run 里排第几，方便知道"这条 run 是不是刚被这一格填满"
  const posIn = Array.from({ length: n }, () => new Map());
  for (const run of runs) run.cells.forEach((t, i) => posIn[t].set(run, i));

  const values = new Uint8Array(n);
  const sums = runs.map(() => 0);
  const used = runs.map(() => new Set());
  let nodes = 0;
  let count = 0;
  let first = null;
  let budgetOut = false;

  const dfs = (k) => {
    if (budgetOut) return;
    nodes++;
    if (nodes > maxNodes) {
      budgetOut = true;
      return;
    }
    if (k === whites.length) {
      count++;
      if (!first) first = Uint8Array.from(values);
      return;
    }
    const t = whites[k];
    const mine = cellRuns[t];
    for (let d = 1; d <= MAX_DIGIT; d++) {
      let ok = true;
      for (const run of mine) {
        if (used[run.id].has(d)) {
          ok = false;
          break;
        }
        const left = run.len - posIn[t].get(run) - 1; // 这一格之后还有几格没定
        const s = sums[run.id] + d;
        if (s > run.clue) {
          ok = false;
          break;
        }
        const rest = used[run.id];
        rest.add(d);
        const lo = minRest(left, rest);
        const hi = maxRest(left, rest);
        rest.delete(d);
        if (s + lo > run.clue || s + hi < run.clue) {
          ok = false;
          break;
        }
        // 这一格正好把 run 收尾：和必须当场对上，不等到叶子再查
        if (left === 0 && s !== run.clue) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      values[t] = d;
      for (const run of mine) {
        sums[run.id] += d;
        used[run.id].add(d);
      }
      dfs(k + 1);
      for (const run of mine) {
        sums[run.id] -= d;
        used[run.id].delete(d);
      }
      values[t] = 0;
      if (count >= limit) return;
    }
  };

  dfs(0);

  const status = budgetOut && count < 2 ? OVERBUDGET : count === 0 ? NONE : count === 1 ? UNIQUE : MANY;
  return { status, count, values: first, nodes, runs: runs.length, whites: whites.length };
}

/** 把按网格下标的解换算成引擎的密集下标（长度 board.n）。比对两个实现时用这个。 */
export function toDense(board, gridValues) {
  const out = new Uint8Array(board.n);
  for (let t = 0; t < board.w * board.h; t++) {
    if (board.black[t]) continue;
    out[board.ordinal[t]] = gridValues[t];
  }
  return out;
}

/** 逐格比对：返回不一致的格子（网格下标）列表。 */
export function diffCells(board, denseA, gridB) {
  const bad = [];
  for (let t = 0; t < board.w * board.h; t++) {
    if (board.black[t]) continue;
    if (denseA[board.ordinal[t]] !== gridB[t]) bad.push(t);
  }
  return bad;
}

/** 独立解一遍，直接给出密集下标的解；无解/多解返回 null。count.js 和 kakuro.js 的唯一交汇点。 */
export function uniqueSolution(board, opts = {}) {
  const r = countSolutions(board, opts);
  if (r.status !== UNIQUE) return null;
  return toDense(board, r.values);
}
