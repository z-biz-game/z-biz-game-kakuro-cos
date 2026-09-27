// run 的组合清单 —— 本作"零猜测"的地基。
//
// 一条 run 是"被黑格夹住的一段连续白格"。它的全部约束就是一句话：L 个互不相同的 1..9 数字，和为 S。
// 这句话小到可以被**穷举**：把 (L, S) 定下来，合法的填法就只有那么几种"数字集合"，一只手数得过来
// （实测最多 12 种，见 maxCombos）。把这张清单列出来、再和交叉那条 run 的清单取交集，就是玩家拿
// 铅笔在格子边上写的"这格只能是 2 或 5"。
//
// 这个文件提供两份东西：
//   * enumerateCombos(L, S) —— 真去把组合一个个列出来（引擎用它做交集）
//   countCombinations(L, S) —— 由 0/1 背包动态规划算出的**条数**，不列组合本身
// 两者互为对账：balance / bake / engine-test 都要逐位比它们相等。列组合的代码写错（少一个数字、
// 把 6 拆成 3+3 这种重复允许）会立刻在数上露出来，而动态规划露不出来——两条路不共享代码。

export const MIN_DIGIT = 1;
export const MAX_DIGIT = 9;
export const MAX_RUN = MAX_DIGIT; // 数字不重复 ⇒ 一条 run 最多 9 格

/** 长度 L 的 run 的最小可能和：1+2+…+L。 */
export function minSum(L) {
  return (L * (L + 1)) / 2;
}

/** 长度 L 的 run 的最大可能和：9+8+…+(10-L)。 */
export function maxSum(L) {
  return (L * (19 - L)) / 2;
}

export function clueLegal(L, S) {
  return L >= 1 && L <= MAX_RUN && Number.isInteger(S) && S >= minSum(L) && S <= maxSum(L);
}

const CACHE = new Map();

/**
 * 长度 L、和 S、数字互不重复且都在 1..9 的全部组合，每组按升序给出。
 * 递归按"从上一位之后继续挑"来生成，所以天然不重复、天然升序。
 */
export function enumerateCombos(L, S) {
  const key = `${L}:${S}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const out = [];
  if (L >= 1 && L <= MAX_RUN && clueLegal(L, S)) {
    const cur = new Array(L);
    const rec = (pos, from, left) => {
      const room = L - pos;
      if (room === 0) {
        if (left === 0) out.push(cur.slice());
        return;
      }
      // 还要凑 left 个数：最小是 from+(from+1)+…，最大是 9+8+…（取最小的 room 个数不行，要最大的）
      if (left < room * (2 * from + room - 1) / 2 || left > (room * (19 - room)) / 2) return;
      for (let d = from; d <= MAX_DIGIT - room + 1; d++) {
        cur[pos] = d;
        rec(pos + 1, d + 1, left - d);
      }
    };
    rec(0, 1, S);
  }
  Object.freeze(out);
  CACHE.set(key, out);
  return out;
}

/**
 * 独立对账用的纯动态规划：从 1..9 里选 k 个不同数字、和为 s，共有多少种选法。
 * 0/1 背包计数：每个数字最多用一次，k 与 s 都倒序更新，所以不会把同一个数字用两遍。
 * 这里刻意不列组合、不查 enumerateCombos 的缓存——两张表各算各的。
 */
export function countCombinations(L, S) {
  if (L < 0 || L > MAX_RUN) return 0;
  const f = Array.from({ length: L + 1 }, () => new Int32Array(S + 1));
  f[0][0] = 1;
  for (let d = 1; d <= MAX_DIGIT; d++) {
    for (let k = L - 1; k >= 0; k--) {
      for (let s = 0; s + d <= S; s++) {
        if (f[k][s]) f[k + 1][s + d] += f[k][s];
      }
    }
  }
  return f[L][S];
}

/** 整张 C(L,S) 表：table[L][S]。动态规划算出，供测试逐位比对。 */
export function countTable(Lmax = MAX_RUN, Smax = 45) {
  const out = [];
  for (let L = 0; L <= Lmax; L++) {
    const row = new Int32Array(Smax + 1);
    for (let S = 0; S <= Smax; S++) row[S] = L === 0 ? (S === 0 ? 1 : 0) : countCombinations(L, S);
    out.push(row);
  }
  return out;
}

/** 一条 run 当前能填的数字集合（位掩码 bit1..bit9）：所有组合的数字并集。 */
export function digitSetOf(L, S) {
  let m = 0;
  for (const combo of enumerateCombos(L, S)) for (const d of combo) m |= 1 << d;
  return m;
}

export const BITS = (d) => 1 << d;
export const POP = (m) => {
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
};
export const FIRST = (m) => {
  let d = 1;
  while (!(m & (1 << d))) d++;
  return d;
};

/** 掩码里的数字列表，升序。 */
export function digitsOf(m) {
  const out = [];
  for (let d = MIN_DIGIT; d <= MAX_DIGIT; d++) if (m & (1 << d)) out.push(d);
  return out;
}
