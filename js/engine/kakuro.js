// 加算十字 · Kakuro 引擎。
//
// 盘面 = 黑格 + 白格。黑格里印的两个数各自管一条 run：写在右下的那个管"这格右边那一横串白格"，
// 写在右上的那个管"这格下边那一竖串白格"。白格填 1..9，要求只有两条——同一条 run 内不重复、
// 和等于线索。规则全文在 README；这个文件只做四件事：
//   createBoard  把结构 + 线索变成可查的 run 表，并在这里就把"线索必须在 [minSum(L), maxSum(L)] 内、
//                长度 ≤ 9"钉死（规则 3 是构造期断言，不是运行期侥幸）
//   solve        铅笔路径：组合清单交集 → 唯一组合/必含之数 → 占位排他 → 进差法。绝不回溯。
//   verify       独立验收：重新扫一遍网格，只读盘面，不读 solve 的任何产物
//   diagnose / reachable  给界面用的实时读数
//
// solve() 同时是玩家的路线、出货的验收和提示的来源，所以它一次都不许猜；搜索只活在 count.js 里。

import {
  BITS,
  FIRST,
  POP,
  clueLegal,
  digitSetOf,
  enumerateCombos,
  maxSum,
  minSum,
} from './combos.js';

export { clueLegal, digitSetOf, enumerateCombos, maxSum, minSum, BITS, FIRST, POP };

export const BLACK = 1;
export const WHITE = 0;
export const NO_CLUE = 0; // 黑格某一侧不写数；一条 run 的和最小是 1，所以 0 永远不会是合法线索
export const EMPTY = 0; // 白格还没填；数字从 1 起，所以 0 也永远不会是一个填法
export const ACROSS = 0;
export const DOWN = 1;
export const MAX_DIGIT = 9;

// ---- 名字与编码 ------------------------------------------------------------------------------

export const cellName = (w, t) => `第${Math.floor(t / w) + 1}行${(t % w) + 1}列`;

export function runName(board, run) {
  const a = board.cellOf[run.cells[0]];
  const b = board.cellOf[run.cells[run.cells.length - 1]];
  const dir = run.dir === ACROSS ? '横向' : '纵向';
  const along =
    run.dir === ACROSS
      ? `第${Math.floor(a / board.w) + 1}行 ${a % board.w + 1}~${b % board.w + 1}列`
      : `第${a % board.w + 1}列 ${Math.floor(a / board.w) + 1}~${Math.floor(b / board.w) + 1}行`;
  return `${dir} ${along}（${run.len} 格，和 ${run.clue}）`;
}

/** 一格属于哪两条 run：[横向 run 下标, 纵向 run 下标]。 */
export function runsOfCell(board, t) {
  return [board.acrossRun[t], board.downRun[t]];
}

export function runOfClueHome(board, home, dir) {
  return board.runs.find((r) => r.home === home && r.dir === dir) || null;
}

// 线索/结构的紧凑编码：一格一字符。字符表 62 个（0-9A-Za-z），要表示的最大值是 45
// —— 9+8+…+1，也就是 9 格 run 的和上限 —— 36 个字符不够用，所以把小写字母也请进来。
// 黑格表只用得上前两个字符。
export const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const MAX_ENCODED = CHARS.length - 1; // 61
const CHAR_AT = Object.create(null);
for (let i = 0; i < CHARS.length; i++) CHAR_AT[CHARS[i]] = i;

/** 把一条 w*h 长度的数值列编码成一个字符一格的字串。 */
export function encodeColumn(arr) {
  let out = '';
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v < 0 || v >= CHARS.length) throw new Error(`编码越界：${v}`);
    out += CHARS[v];
  }
  return out;
}

/**
 * 解码。`what` 出现在错误里，让 bake --check 的失败信息能指回是哪一列出错。
 * 这里刻意不做任何"顺手补全"：长度不对就是不对。
 */
export function decodeColumn(w, h, text, what) {
  const n = w * h;
  if (typeof text !== 'string' || text.length !== n) {
    throw new Error(`${what} 应该是 ${n} 个字符，收到 ${text == null ? text : text.length} 个`);
  }
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const v = CHAR_AT[text[i]];
    if (v === undefined) throw new Error(`${what} 第 ${i + 1} 格是「${text[i]}」，不在 ${CHARS} 里`);
    out[i] = v;
  }
  return out;
}

export function encodeBoard(board) {
  return {
    w: board.w,
    h: board.h,
    bl: encodeColumn(board.black),
    ac: encodeColumn(board.across),
    dn: encodeColumn(board.down),
  };
}

// ---- 构造与结构 ------------------------------------------------------------------------------

/**
 * 从"黑格 + 两组线索"建盘。白格按扫描序重编号为 0..n-1，run 存的是这个编号，
 * `cellOf` 把它映射回网格下标——渲染层要网格下标，求解器要密集数组，两边都别将就。
 */
export function createBoard({ w, h, black, across, down }) {
  if (!(w >= 2 && h >= 2)) throw new Error('盘面至少 2×2');
  const n = w * h;
  if (black.length !== n || across.length !== n || down.length !== n) {
    throw new Error(`黑格表/线索表长度应为 ${n}，收到 ${black.length}/${across.length}/${down.length}`);
  }
  const bl = Uint8Array.from(black, (v) => (v ? 1 : 0));
  const isBlack = (r, c) => bl[r * w + c] === 1;

  // 每条 run 都得有人写它的和：横向 run 的和在它左邻的黑格里，纵向 run 的和在它上邻的黑格里。
  // 于是第一行、第一列必须整条是黑格。
  for (let c = 0; c < w; c++) if (!isBlack(0, c)) throw new Error(`第1行第${c + 1}列是白格：它下边的纵向 run 没有地方写和`);
  for (let r = 0; r < h; r++) if (!isBlack(r, 0)) throw new Error(`第${r + 1}行第1列是白格：它右边的横向 run 没有地方写和`);

  // 白格重编号
  const cellOf = [];
  const ordinal = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    if (bl[t]) continue;
    ordinal[t] = cellOf.length;
    cellOf.push(t);
  }
  const nw = cellOf.length;
  if (!nw) throw new Error('盘上没有白格');

  const runs = [];
  const acrossRun = new Int32Array(nw).fill(-1);
  const downRun = new Int32Array(nw).fill(-1);

  const addRun = (dir, cells, gridCells, clue, home, where) => {
    const id = runs.length;
    const len = cells.length;
    if (len > MAX_DIGIT) {
      throw new Error(`${where} 有 ${len} 格，超过 9：1..9 互不重复填不满这么长的一条 run`);
    }
    if (!clueLegal(len, clue)) {
      throw new Error(
        `${where} 写着和 ${clue}，但 ${len} 格的合法区间是 ${minSum(len)}~${maxSum(len)}`,
      );
    }
    runs.push({ id, dir, cells, gridCells, clue, len, home, where });
    const slot = dir === ACROSS ? acrossRun : downRun;
    for (const t of cells) slot[t] = id;
  };

  // 黑格里写了数，右边/下边就必须真有白格接着——否则那个和没有指任何 run，是画蛇添足。
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (!isBlack(r, c)) continue;
      const i = r * w + c;
      if (across[i] > NO_CLUE && (c + 1 >= w || isBlack(r, c + 1))) {
        throw new Error(`${cellName(w, i)} 的黑格写着横向和 ${across[i]}，可它右边没有白格`);
      }
      if (down[i] > NO_CLUE && (r + 1 >= h || isBlack(r + 1, c))) {
        throw new Error(`${cellName(w, i)} 的黑格写着纵向和 ${down[i]}，可它下边没有白格`);
      }
    }
  }

  // 横向 run
  for (let r = 0; r < h; r++) {
    let c = 0;
    while (c < w) {
      if (isBlack(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < w && !isBlack(r, c)) c++;
      const gridCells = [];
      for (let k = start; k < c; k++) gridCells.push(r * w + k);
      const home = r * w + start - 1;
      const clue = across[home];
      const where = `第${r + 1}行 ${start + 1}~${c}列 的横向 run`;
      if (!isBlack(r, start - 1)) throw new Error(`${where} 左边不是黑格`);
      if (clue <= NO_CLUE) throw new Error(`${where} 左边没有写和`);
      addRun(ACROSS, gridCells.map((t) => ordinal[t]), gridCells, clue, home, where);
    }
  }
  // 纵向 run
  for (let c = 0; c < w; c++) {
    let r = 0;
    while (r < h) {
      if (isBlack(r, c)) {
        r++;
        continue;
      }
      const start = r;
      while (r < h && !isBlack(r, c)) r++;
      const gridCells = [];
      for (let k = start; k < r; k++) gridCells.push(k * w + c);
      const home = (start - 1) * w + c;
      const clue = down[home];
      const where = `第${c + 1}列 ${start + 1}~${r}行 的纵向 run`;
      if (!isBlack(start - 1, c)) throw new Error(`${where} 上边不是黑格`);
      if (clue <= NO_CLUE) throw new Error(`${where} 上边没有写和`);
      addRun(DOWN, gridCells.map((t) => ordinal[t]), gridCells, clue, home, where);
    }
  }

  // 每格的初始候选域 = 两条 run 组合清单的数字并集再取交集。空集不在这一步报错，
  // 交给 solve 说成"矛盾"——那是一句玩家听得懂的话，不是一个构造异常。
  const initMask = new Uint16Array(nw);
  for (const run of runs) {
    const set = digitSetOf(run.len, run.clue);
    for (const t of run.cells) initMask[t] = initMask[t] ? initMask[t] & set : set;
  }

  let clues = 0;
  for (let i = 0; i < n; i++) {
    if (across[i] > NO_CLUE) clues++;
    if (down[i] > NO_CLUE) clues++;
  }
  if (!clues) throw new Error('盘上没有线索');
  if (clues !== runs.length) throw new Error(`印出的和有 ${clues} 个，可 run 有 ${runs.length} 条——结构对不上`);

  return {
    w,
    h,
    size: n,
    n: nw,
    black: bl,
    across: Int8Array.from(across),
    down: Int8Array.from(down),
    cellOf,
    ordinal,
    runs,
    acrossRun,
    downRun,
    initMask,
    clues,
    whites: Array.from({ length: nw }, (_, i) => i),
    name: (t) => cellName(w, cellOf[t]),
    runName: (id) => runName({ w, cellOf }, runs[id]),
  };
}

/** 由一份填法（长度 n 的 1..9 数组）算出全部线索，写回它自己的黑格上。生成器用，验收器不用。 */
export function cluesFrom(board, values) {
  const across = Int8Array.from(board.across);
  const down = Int8Array.from(board.down);
  across.fill(NO_CLUE);
  down.fill(NO_CLUE);
  for (const run of board.runs) {
    let s = 0;
    for (const t of run.cells) s += values[t];
    const arr = run.dir === ACROSS ? across : down;
    if (arr[run.home] > NO_CLUE && arr[run.home] !== s) {
      throw new Error(`${run.where} 填出来的和是 ${s}，可那格黑格里已经写着 ${arr[run.home]}`);
    }
    arr[run.home] = s;
  }
  return { across, down };
}

// ---- 规则 ------------------------------------------------------------------------------------
//
// 六条，一条比一条深。前四条只查一条 run 自己的组合清单，第五条要跑匹配，第六条要跨片区算和的差。
// 每一条写下的候选消去/落子都在盘面的**每一个解**里成立（论证见 DESIGN §3、§5），所以
//   ① 铅笔推得完 ⇒ 解唯一，② 提示永远不会说出一个不该说出的数，③ reachable 不会冤枉玩家。

export const Rules = {
  combo: {
    key: 'combo',
    name: '组合清单',
    level: 1,
    weight: 1,
    text: (b, d) =>
      `${b.runName(d.run)} 的组合清单里，${b.name(d.cell)} 只剩 ${d.candidates}。`,
  },
  unique: {
    key: 'unique',
    name: '唯一组合',
    level: 2,
    weight: 1.6,
    text: (b, d) =>
      `${b.runName(d.run)} 只剩一种组合 {${d.combo}}——这一 run 的格子全部落在这几个数里。`,
  },
  hidden: {
    key: 'hidden',
    name: '必含之数',
    level: 2,
    weight: 2.2,
    text: (b, d) =>
      `${b.runName(d.run)} 每一种组合都含 ${d.digit}，而这条 run 里只有 ${b.name(d.cell)} 放得下它。`,
  },
  slot: {
    key: 'slot',
    name: '占位排他',
    level: 2,
    weight: 2.6,
    text: (b, d) =>
      `${b.runName(d.run)} 的候选格子摆不出"${d.digit} 放在 ${b.name(d.cell)}"这一种排法，划掉。`,
  },
  region: {
    key: 'region',
    name: '进差法',
    level: 3,
    weight: 5,
    text: (b, d) =>
      `${d.regionText}${d.digit == null ? '' : ` ${b.name(d.cell)} 填 ${d.digit} 就凑不出这个和，划掉。`}`,
  },
  bare: {
    key: 'bare',
    name: '只剩一个',
    level: 1,
    weight: 1,
    text: (b, d) => `${b.name(d.cell)} 被两条 run 的组合清单夹到只剩 ${d.digit}。`,
  },
};

export const RULE_LEVELS = 3;

// 一条 run 当前的账：已用的数字、剩余空格、以及"这个盘面下这条 run 还剩几种组合"。
function runAccount(board, run, val, mask) {
  let used = 0;
  let sum = 0;
  let dup = 0;
  const free = [];
  let union = 0;
  for (const t of run.cells) {
    const v = val[t];
    if (v) {
      if (used & BITS(v)) dup = v;
      used |= BITS(v);
      sum += v;
    } else {
      free.push(t);
      union |= mask[t];
    }
  }
  return { used, sum, dup, free, union };
}

// 与当前账相容的组合：包含全部已填数字，且剩下的数字各有格子可去（并集粗筛）。
function liveCombos(run, acc) {
  const out = [];
  for (const combo of enumerateCombos(run.len, run.clue)) {
    let m = 0;
    for (const d of combo) m |= BITS(d);
    if ((m & acc.used) !== acc.used) continue;
    if ((m & ~acc.used & ~acc.union) !== 0) continue;
    out.push({ digits: combo, mask: m });
  }
  return out;
}

const fmtCandidates = (m) => {
  const out = [];
  for (let d = 1; d <= MAX_DIGIT; d++) if (m & BITS(d)) out.push(d);
  return out.join('/');
};

// 二部图完美匹配：digits 各占一格，格子的域由 mask 给出；forced = [digit, cell] 时先钉死这一对。
function canMatch(digits, cells, mask, forcedDigit, forcedCell) {
  const pairOf = new Int8Array(cells.length).fill(0); // 该格分到的数字，0 = 还没分
  const cellOfDigit = new Int8Array(digits.length).fill(-1);
  const slotOf = new Map();
  for (let i = 0; i < cells.length; i++) slotOf.set(cells[i], i);
  let need = digits.length;
  if (need !== cells.length) return false;
  if (forcedDigit != null) {
    const ci = slotOf.get(forcedCell);
    if (ci === undefined || !(mask[forcedCell] & BITS(forcedDigit))) return false;
    let found = false;
    for (let i = 0; i < digits.length; i++) if (digits[i] === forcedDigit) found = true;
    if (!found) return false;
    pairOf[ci] = forcedDigit;
    for (let i = 0; i < digits.length; i++) if (digits[i] === forcedDigit) cellOfDigit[i] = ci;
    need--;
  }
  const taken = (cellIdx) => pairOf[cellIdx] !== 0;
  const seen = new Uint8Array(cells.length);
  const aug = (di) => {
    for (let ci = 0; ci < cells.length; ci++) {
      if (seen[ci]) continue;
      const cell = cells[ci];
      if (!(mask[cell] & BITS(digits[di]))) continue;
      seen[ci] = 1;
      if (!taken(ci)) {
        pairOf[ci] = digits[di];
        cellOfDigit[di] = ci;
        return true;
      }
      if (ci === slotOf.get(forcedCell)) continue; // 钉死的那对不许被抢
      const old = pairOf[ci];
      let oldDi = -1;
      for (let k = 0; k < digits.length; k++) if (digits[k] === old) oldDi = k;
      if (oldDi < 0 || cellOfDigit[oldDi] !== ci) continue;
      if (aug(oldDi)) {
        pairOf[ci] = digits[di];
        cellOfDigit[di] = ci;
        return true;
      }
    }
    return false;
  };
  for (let di = 0; di < digits.length; di++) {
    if (cellOfDigit[di] >= 0) continue;
    seen.fill(0);
    if (!aug(di)) return false;
    need--;
  }
  return need === 0;
}

/**
 * 用一条 run 的组合清单收紧这盘。写回 mask/val，返回改动了什么。
 * strong=true 时再跑"占位排他"（匹配级相容），那是玩家拿铅笔反复试摆的那一步。
 */
function tightenRun(board, run, val, mask, events, strong) {
  const acc = runAccount(board, run, val, mask);
  if (acc.dup) {
    return { conflict: `${run.where} 里 ${acc.dup} 出现了两次——同一条 run 数字不能重复。` };
  }
  if (!acc.free.length) {
    if (acc.sum !== run.clue) {
      return { conflict: `${run.where} 已经填满，和是 ${acc.sum}，对不上 ${run.clue}。` };
    }
    return { changed: false };
  }
  if (acc.sum > run.clue) {
    return { conflict: `${run.where} 已经写到 ${acc.sum}，超过线索 ${run.clue}。` };
  }
  const all = liveCombos(run, acc);
  if (!all.length) {
    return {
      conflict: `${run.where} 一种组合都不剩：已填 ${acc.sum}，剩下 ${acc.free.length} 格的候选里凑不出 ${run.clue - acc.sum}。`,
    };
  }
  let changed = false;
  const only = all.length === 1;
  const rule = only ? Rules.unique : Rules.combo;
  const comboText = only ? all[0].digits.join(',') : '';

  // ① 并集交集：这格能填的数字 = 这条 run 活下来的组合里的数字并集（去掉已被占用的）
  let avail = 0;
  for (const c of all) avail |= c.mask & ~acc.used;
  for (const t of acc.free) {
    const next = mask[t] & avail;
    if (next === mask[t]) continue;
    if (!next) {
      return {
        conflict: `${run.where} 走到尽头：${board.name(t)} 的候选被这条 run 的组合清单清空了。`,
      };
    }
    const killed = mask[t] & ~next;
    mask[t] = next;
    changed = true;
    for (let d = 1; d <= MAX_DIGIT; d++) {
      if (!(killed & BITS(d))) continue;
      events.push({
        kind: 'prune',
        cell: t,
        digit: d,
        run: run.id,
        rule,
        candidates: fmtCandidates(next),
        combo: comboText,
        level: rule.level,
      });
    }
  }

  // ② 唯一组合还能再说一句：这一 run 用的就是这套数字，交叉那格要是容不下整套就矛盾
  if (only) {
    const set = all[0].digits;
    for (const t of acc.free) {
      if ((mask[t] & all[0].mask) === 0) {
        return { conflict: `${run.where} 只剩组合 {${set.join(',')}}，可 ${board.name(t)} 一个都容不下。` };
      }
    }
  }

  // ③ 必含之数：活下来的**每一种**组合都含 d，而这条 run 里只有格子放得下 d
  for (let d = 1; d <= MAX_DIGIT; d++) {
    if (acc.used & BITS(d)) continue;
    if (!all.every((c) => c.mask & BITS(d))) continue;
    const homes = acc.free.filter((t) => mask[t] & BITS(d));
    if (!homes.length) {
      return { conflict: `${run.where} 每种组合都含 ${d}，可这 ${acc.free.length} 格没有一格放得下它。` };
    }
    if (homes.length === 1 && val[homes[0]] === 0) {
      if (!place(board, val, mask, events, homes[0], d, Rules.hidden, run.id, { digit: d, candidates: fmtCandidates(mask[homes[0]] & BITS(d)) })) {
        return { conflict: `${run.where} 里 ${d} 只能放在 ${board.name(homes[0])}，可那格已经填了别的。` };
      }
      changed = true;
    }
  }

  // ④ 占位排他（只在并集推完仍然卡住时跑）
  if (strong) {
    const live = [];
    for (const c of all) {
      const rest = c.digits.filter((d) => !(acc.used & BITS(d)));
      if (rest.length !== acc.free.length) continue;
      if (canMatch(rest, acc.free, mask, null, null)) live.push({ digits: rest, mask: c.mask });
    }
    if (!live.length) {
      return {
        conflict: `${run.where} 摆不开了：剩下的数字放不进剩下这些格子的候选里。`,
      };
    }
    for (const t of acc.free) {
      let kill = 0;
      for (let d = 1; d <= MAX_DIGIT; d++) {
        if (!(mask[t] & BITS(d))) continue;
        let ok = false;
        for (const c of live) {
          if (!c.digits.includes(d)) continue;
          if (canMatch(c.digits, acc.free, mask, d, t)) {
            ok = true;
            break;
          }
        }
        if (!ok) kill |= BITS(d);
      }
      if (!kill) continue;
      const next = mask[t] & ~kill;
      if (!next) {
        return { conflict: `${run.where} 的排法互相挤死：${board.name(t)} 没有可放的位置了。` };
      }
      mask[t] = next;
      changed = true;
      for (let d = 1; d <= MAX_DIGIT; d++) {
        if (!(kill & BITS(d))) continue;
        events.push({
          kind: 'prune',
          cell: t,
          digit: d,
          run: run.id,
          rule: Rules.slot,
          candidates: fmtCandidates(next),
          level: Rules.slot.level,
        });
      }
    }
  }
  return { changed };
}

function place(board, val, mask, events, t, digit, rule, run, extra = {}) {
  if (val[t] === digit) return true; // 已经这么写了：不重复记账，也不报错
  if (val[t]) return false;
  val[t] = digit;
  mask[t] = BITS(digit);
  events.push({
    kind: 'place',
    cell: t,
    digit,
    run,
    rule,
    level: rule.level,
    candidates: String(digit),
    ...extra,
  });
  return true;
}

// 把已经被夹到只剩一个候选的格子写下来。
function drainSingles(board, val, mask, events) {
  let changed = false;
  for (const t of board.whites) {
    if (val[t] || POP(mask[t]) !== 1) continue;
    const d = FIRST(mask[t]);
    const cause = lastCause(events, t);
    place(board, val, mask, events, t, d, cause || Rules.bare, cause ? cause.run : board.acrossRun[t], { digit: d });
    changed = true;
  }
  return changed;
}

function lastCause(events, t) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'prune' && e.cell === t) return e.rule === Rules.combo ? Rules.bare : e.rule;
  }
  return null;
}

// ---- 进差法 ----------------------------------------------------------------------------------
//
// 把若干整行看成一片。这片里每条横向 run 都完整落在片内，所以"片内横向和之和"就是"这片所有白格
// 之和"。再减去那些**完整**落在片内的纵向 run 的和，剩下的就是那些"从片里伸出去"的格子的和。
// 这个差不依赖任何猜测，只依赖"每条 run 的和都写着"这一条事实，所以它对盘面的每一个解都成立
// （推导见 DESIGN §5）。纵向片对称。

function buildRegions(board) {
  const out = [];
  const rows = [];
  const cols = [];
  for (let r = 0; r < board.h; r++) rows.push(r);
  for (let c = 0; c < board.w; c++) cols.push(c);
  const push = (kind, from, to) => {
    if (to - from > 4) return; // 超过 5 行/列的片区实测不再给出新东西，只拖慢每一步
    const lineIdx = kind === 'rows' ? rows.slice(from, to + 1) : cols.slice(from, to + 1);
    const inSet = (t) => {
      const g = board.cellOf[t];
      return lineIdx.includes(kind === 'rows' ? Math.floor(g / board.w) : g % board.w);
    };
    const cells = [];
    for (const t of board.whites) if (inSet(t)) cells.push(t);
    if (!cells.length) return;
    const inside = new Set(cells);
    let aSum = 0;
    let aRuns = 0;
    let bSum = 0;
    const crossing = [];
    const covered = new Set();
    for (const run of board.runs) {
      const same = run.dir === (kind === 'rows' ? DOWN : ACROSS);
      const other = !same;
      const inCells = run.cells.filter((t) => inside.has(t));
      if (!inCells.length) continue;
      if (other) {
        // 这一方向的 run 必须完整在片内（片是整行/整列，所以按构造必然成立）
        if (inCells.length !== run.cells.length) return; // 结构不像预期：这片不要
        aSum += run.clue;
        aRuns++;
        continue;
      }
      if (inCells.length === run.cells.length) {
        bSum += run.clue;
        for (const t of run.cells) covered.add(t);
      } else {
        crossing.push({ run, inCells });
      }
    }
    const innies = cells.filter((t) => !covered.has(t));
    const outs = [];
    for (const { run } of crossing) {
      for (const t of run.cells) if (!inside.has(t)) outs.push(t);
    }
    const label = `${kind === 'rows' ? '行' : '列'} ${lineIdx.map((i) => i + 1).join('、')}`;
    out.push({
      kind,
      label,
      aSum,
      aRuns,
      bSum,
      innerB: crossing.reduce((s, x) => s + x.run.clue, 0),
      innies,
      inniesTarget: aSum - bSum,
      outies: Array.from(new Set(outs)),
      outiesTarget: crossing.reduce((s, x) => s + x.run.clue, 0) - (aSum - bSum),
      crossing: crossing.length,
    });
  };
  for (let a = 0; a < board.h; a++) for (let b = a; b < board.h; b++) push('rows', a, b);
  for (let a = 0; a < board.w; a++) for (let b = a; b < board.w; b++) push('cols', a, b);
  return out.filter((rg) => rg.innies.length || rg.outies.length);
}

// "这些格之和必须是 K" —— 用前缀/后缀可达和把它变成每格能填什么。
// 这里是**松弛**：只要求和成立，不管同一条 run 不重复。松弛只会漏推，不会错推：
// 松弛无解 ⇒ 真问题也无解，所以这条规则划掉的候选、报出的矛盾都是真的。
function hiOf(m) {
  for (let d = MAX_DIGIT; d >= 1; d--) if (m & BITS(d)) return d;
  return 0;
}

function sumFilter(cells, mask, K) {
  const m = cells.length;
  let lo = 0;
  let hi = 0;
  for (const t of cells) {
    if (!mask[t]) return { conflict: true, why: '有一格候选已经空了' };
    lo += FIRST(mask[t]);
    hi += hiOf(mask[t]);
  }
  if (K < lo || K > hi) {
    return { conflict: true, why: `这些格最少能凑 ${lo}、最多能凑 ${hi}，凑不出 ${K}` };
  }
  if (m === 1) {
    const t = cells[0];
    if (!(mask[t] & BITS(K))) return { conflict: true, why: `${K} 不在这一格的候选里` };
    return { conflict: false, keep: [BITS(K)] };
  }
  // reach[i] = 前 i 格能凑出的和的集合
  const reach = (list) => {
    const pre = [new Uint8Array(K + 1)];
    pre[0][0] = 1;
    for (let i = 0; i < list.length; i++) {
      const cur = new Uint8Array(K + 1);
      const prev = pre[i];
      const mm = mask[list[i]];
      for (let s = 0; s <= K; s++) {
        if (!prev[s]) continue;
        for (let d = 1; d <= MAX_DIGIT; d++) {
          if (!(mm & BITS(d))) continue;
          if (s + d <= K) cur[s + d] = 1;
        }
      }
      pre.push(cur);
    }
    return pre;
  };
  const pre = reach(cells);
  const sufRaw = reach(cells.slice().reverse());
  const suf = [];
  for (let i = 0; i <= m; i++) suf.push(sufRaw[m - i]);
  const keep = [];
  for (let i = 0; i < m; i++) {
    const t = cells[i];
    let k = 0;
    for (let d = 1; d <= MAX_DIGIT; d++) {
      if (!(mask[t] & BITS(d)) || d > K) continue;
      let ok = false;
      for (let a = 0; a + d <= K && !ok; a++) {
        if (!pre[i][a]) continue;
        if (suf[i + 1][K - d - a]) ok = true;
      }
      if (ok) k |= BITS(d);
    }
    if (!k) return { conflict: true, why: `${K} 这个和在剩下的候选里凑不出来` };
    keep.push(k);
  }
  return { conflict: false, keep };
}

function sweepRegion(board, region, val, mask, events) {
  let changed = false;
  const sides = [
    { cells: region.innies, K: region.inniesTarget },
    { cells: region.outies, K: region.outiesTarget },
  ];
  const vm = valMask(board, val, mask);
  for (const side of sides) {
    if (!side.cells.length || side.K < 1) continue;
    // 全落定、或者全是单候选的集合不用再算
    if (!side.cells.some((t) => !val[t] && POP(mask[t]) > 1)) continue;
    const r = sumFilter(side.cells, vm, side.K);
    if (r.conflict) {
      return { conflict: `${regionLabel(board, region, side)}：${r.why}` };
    }
    for (let i = 0; i < side.cells.length; i++) {
      const t = side.cells[i];
      if (val[t]) continue;
      const next = mask[t] & r.keep[i];
      if (next === mask[t]) continue;
      if (!next) {
        return { conflict: `${regionLabel(board, region, side)}：${board.name(t)} 没有能用的候选` };
      }
      const killed = mask[t] & ~next;
      mask[t] = next;
      changed = true;
      for (let d = 1; d <= MAX_DIGIT; d++) {
        if (!(killed & BITS(d))) continue;
        events.push({
          kind: 'prune',
          cell: t,
          digit: d,
          run: board.acrossRun[t],
          rule: Rules.region,
          regionText: regionLabel(board, region, side),
          candidates: fmtCandidates(next),
          level: Rules.region.level,
        });
      }
    }
  }
  return { changed };
}

function regionLabel(board, region, side) {
  const inText =
    side.cells.length === 1
      ? `只有 ${board.name(side.cells[0])} 一格在${side.cells === region.innies ? '这片里' : '这片外'}伸着，它必须是 ${side.K}`
      : `${side.cells === region.innies ? '这片里' : '这片外'}那 ${side.cells.length} 格（${side.cells.map((t) => board.name(t)).join('、')}）之和必须是 ${side.K}`;
  return `把${region.label}看成一片：这片完整横向/纵向 run 的和一共 ${region.aSum}，完整落在片内的另一向 run 写着 ${region.bSum}，所以${inText}`;
}

function valMask(board, val, mask) {
  const out = new Uint16Array(mask.length);
  for (const t of board.whites) out[t] = val[t] ? BITS(val[t]) : mask[t];
  return out;
}

// ---- 铅笔路径 --------------------------------------------------------------------------------

/**
 * 从空盘（或从 `seed` 里玩家已经写下的数）推到不能再推。
 * `regions=false` 时只用单条 run 的规则——生成器正是拿这两个版本的差
 * 当"这一局要不要进差法"的量出来用的；提示/验收也走这同一个函数，绝不再写第二套推导。
 */
export function solve(board, opts = {}) {
  const { regions = true, strong = true, maxRounds = 200, seed = null } = opts;
  const val = seed ? Uint8Array.from(seed) : new Uint8Array(board.n);
  const mask = Uint16Array.from(board.initMask);
  for (const t of board.whites) if (val[t]) mask[t] = BITS(val[t]);
  const events = [];
  const breakdown = {};
  let depth = 0;
  let rounds = 0;
  let regionTouched = false;

  const note = (rule) => {
    const cur = breakdown[rule.key] || { n: 0, weight: rule.weight, level: rule.level };
    cur.n++;
    breakdown[rule.key] = cur;
    if (rule.level > depth) depth = rule.level;
  };

  for (;;) {
    rounds++;
    let changed = false;
    for (const run of board.runs) {
      const r = tightenRun(board, run, val, mask, events, false);
      if (r.conflict) return finish(board, null, r.conflict, events, breakdown, rounds, depth, regionTouched);
      changed = r.changed || changed;
    }
    if (drainSingles(board, val, mask, events)) changed = true;
    if (!changed && strong) {
      for (const run of board.runs) {
        const r = tightenRun(board, run, val, mask, events, true);
        if (r.conflict) return finish(board, null, r.conflict, events, breakdown, rounds, depth, regionTouched);
        changed = r.changed || changed;
      }
      if (drainSingles(board, val, mask, events)) changed = true;
    }
    if (!changed && regions) {
      const table = regionTable(board);
      for (const region of table) {
        const r = sweepRegion(board, region, val, mask, events);
        if (r.conflict) return finish(board, null, r.conflict, events, breakdown, rounds, depth, true);
        if (r.changed) {
          changed = true;
          regionTouched = true;
        }
      }
      if (drainSingles(board, val, mask, events)) changed = true;
    }
    if (!changed) break;
    if (rounds > maxRounds) {
      return finish(board, null, '推导没有收敛（引擎缺陷）', events, breakdown, rounds, depth, regionTouched);
    }
  }

  const ok = val.every((v) => v !== 0);
  for (const e of events) note(e.rule);
  return finish(board, { val, mask }, null, events, breakdown, rounds, depth, regionTouched, ok);
}

function regionTable(board) {
  if (!board._regions) board._regions = buildRegions(board);
  return board._regions;
}

function finish(board, state, conflict, events, breakdown, rounds, depth, regionTouched, okIn) {
  const places = events.filter((e) => e.kind === 'place');
  const prunes = events.filter((e) => e.kind === 'prune');
  let score = 0;
  for (const e of events) score += (e.kind === 'place' ? 1 : 0.2) * e.rule.weight;
  const filled = state ? state.val.reduce((s, v) => s + (v ? 1 : 0), 0) : 0;
  const ok = conflict ? false : okIn && filled === board.n;
  return {
    ok,
    conflict: conflict || null,
    values: state ? state.val : null,
    masks: state ? state.mask : null,
    rows: places,
    events,
    places: places.length,
    prunes: prunes.length,
    steps: places.length,
    rounds,
    score: Math.round(score * 10) / 10,
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, v.n])),
    depth: conflict ? depth : ok ? depth : Math.max(depth, 1),
    regionUsed: regionTouched,
    filled,
  };
}

/**
 * 把玩家的墨水当成前提跑一遍铅笔路径：推出矛盾 ⇒ 这盘确实救不回来了。
 * 它直接复用 solve()，不是偷懒：铅笔的每条规则都对盘面的**每一个解**成立，
 * 所以"铅笔说矛盾"必然是真矛盾（不会冤枉玩家）。反过来铅笔说没矛盾并不保证还能赢 ——
 * 那由 count.js 的穷举负责，两边各司其职。
 */
export function reachable(board, val, opts = {}) {
  const r = solve(board, { ...opts, seed: val, maxRounds: opts.maxRounds || 60 });
  return !r.conflict;
}

// ---- 验收与读数 ------------------------------------------------------------------------------

/**
 * 独立验收：**重新扫一遍网格**，不用 board.runs、不读推导脚本。
 * 这条纪律的意义在 DESIGN §7：如果验收复用 run 表，那么 run 表建错（比如漏掉一段）就会
 * 同时把"解"和"验"带进同一个坑里，游戏会永远判胜。
 */
export function verify(board, values) {
  const { w, h, black, across, down, ordinal } = board;
  const bad = [];
  const line = (dir, clueOf, where) => {
    for (let a = 0; a < (dir === ACROSS ? h : w); a++) {
      let b = 0;
      while (b < (dir === ACROSS ? w : h)) {
        const cellAt = (i) => (dir === ACROSS ? a * w + i : i * w + a);
        if (black[cellAt(b)]) {
          b++;
          continue;
        }
        const start = b;
        while (b < (dir === ACROSS ? w : h) && !black[cellAt(b)]) b++;
        const cells = [];
        for (let i = start; i < b; i++) cells.push(cellAt(i));
        const home = dir === ACROSS ? a * w + start - 1 : (start - 1) * w + a;
        const want = clueOf[home];
        let sum = 0;
        let empty = 0;
        const seen = new Set();
        for (const g of cells) {
          const v = values[ordinal[g]];
          if (!v) empty++;
          else {
            if (seen.has(v)) bad.push({ why: '同一条 run 数字重复', digit: v, run: where(a, start, b) });
            seen.add(v);
            sum += v;
          }
        }
        if (empty) bad.push({ why: '还有空格没填', run: where(a, start, b), empty });
        else if (sum !== want) {
          bad.push({ why: sum > want ? '和超了' : '和不够', want, sum, run: where(a, start, b) });
        }
      }
    }
  };
  const whereAc = (a, s) => `第${a + 1}行 ${s + 1}列起的横向 run`;
  const whereDn = (a, s) => `第${a + 1}列 ${s + 1}行起的纵向 run`;
  line(ACROSS, across, whereAc);
  line(DOWN, down, whereDn);
  return bad;
}

export function complete(board, values) {
  for (const t of board.whites) if (!values[t]) return false;
  return verify(board, values).length === 0;
}

/** 给界面用的实时读数：每条 run 现在什么状况、哪几条撞破、哪几条已经对上。 */
export function diagnose(board, values) {
  const runs = [];
  let satisfied = 0;
  const badRuns = new Set();
  const badCells = new Set();
  for (const run of board.runs) {
    let sum = 0;
    let empty = 0;
    let dup = 0;
    const seen = new Set();
    for (const t of run.cells) {
      const v = values[t];
      if (!v) empty++;
      else {
        if (seen.has(v)) dup = v;
        seen.add(v);
        sum += v;
      }
    }
    const over = sum > run.clue;
    const maxRest = empty ? maxFillOf(empty, seen) : 0;
    const minRest = empty ? minFillOf(empty, seen) : 0;
    const shortBy = sum + maxRest < run.clue;
    const unreachable = empty ? minRest > run.clue - sum : false;
    const done = empty === 0 && sum === run.clue && !dup;
    const status = dup ? 'dup' : over ? 'over' : shortBy || unreachable ? 'short' : done ? 'done' : 'open';
    if (done) satisfied++;
    if (dup || over || shortBy || unreachable) {
      badRuns.add(run.id);
      for (const t of run.cells) if (values[t]) badCells.add(t);
    }
    runs.push({ id: run.id, run, sum, empty, dup, status, done });
  }
  const filledCells = values.reduce((s, v) => s + (v ? 1 : 0), 0);
  return {
    runs,
    satisfied,
    filled: filledCells,
    total: board.n,
    remaining: board.n - filledCells,
    clues: board.clues,
    badRuns,
    badCells,
    conflicts: badRuns.size,
  };
}

/** 还能再凑出的最大和：从 9 往下捡没被占用的数字。不改动传进来的集合。 */
function maxFillOf(empty, seen) {
  const taken = new Set(seen);
  let s = 0;
  let k = MAX_DIGIT;
  for (let left = empty; left > 0; left--) {
    while (k >= 1 && taken.has(k)) k--;
    if (k < 1) return 0;
    s += k;
    taken.add(k);
    k--;
  }
  return s;
}

/** 还能再凑出的最小和：从 1 往上捡没被占用的数字。不改动传进来的集合。 */
function minFillOf(empty, seen) {
  const taken = new Set(seen);
  let total = 0;
  let k = 1;
  for (let left = empty; left > 0; left--) {
    while (k <= MAX_DIGIT && taken.has(k)) k++;
    if (k > MAX_DIGIT) return 0;
    total += k;
    taken.add(k);
  }
  return total;
}

/**
 * 玩家要落子了。只有**硬违反**才拒绝：同一 run 重复、和超界、和再也凑不出来。
 * 候选域不够宽不在此列——那是引擎的知识，不该变成界面替玩家做的决定。
 */
export function legalPlace(board, values, t, digit) {
  if (!(t >= 0 && t < board.n)) return { ok: false, why: '这一格不是白格' };
  if (!(digit >= 1 && digit <= MAX_DIGIT)) return { ok: false, why: `只能填 1..9，收到 ${digit}` };
  for (const id of [board.acrossRun[t], board.downRun[t]]) {
    const run = board.runs[id];
    let sum = 0;
    const others = [];
    for (const c of run.cells) {
      if (c === t) continue;
      const v = values[c];
      if (v) {
        sum += v;
        others.push(v);
      }
    }
    if (others.includes(digit)) {
      return { ok: false, run: id, why: `${run.where} 里已经有 ${digit} 了——同一条 run 数字不能重复。` };
    }
    if (sum + digit > run.clue) {
      return {
        ok: false,
        run: id,
        why: `${run.where} 的其他格子已经写了 ${sum}，再加 ${digit} 就是 ${sum + digit}，超过线索 ${run.clue}。`,
      };
    }
    const rest = run.cells.filter((c) => c !== t && !values[c]).length;
    const spare = run.clue - sum - digit;
    const withDigit = new Set([...others, digit]);
    const maxRest = maxFillOf(rest, withDigit);
    const minRest = minFillOf(rest, withDigit);
    if (spare > maxRest) {
      return {
        ok: false,
        run: id,
        why: `${run.where} 写着 ${run.clue}，落 ${digit} 之后剩下 ${rest} 格最多再凑 ${maxRest}，够不到。`,
      };
    }
    if (spare < minRest) {
      return {
        ok: false,
        run: id,
        why: `${run.where} 写着 ${run.clue}，落 ${digit} 之后剩下 ${rest} 格至少要 ${minRest}，压不下去。`,
      };
    }
  }
  return { ok: true };
}

export { maxFillOf, minFillOf };
