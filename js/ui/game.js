// 对局状态机。这里没有规则，只有"玩家按了一下之后盘面变成什么"。
//
// 三条纪律：
//   ① 落子是否合法只问 engine 的 legalPlace —— 它只拦"这条 run 的和超界/数字重复/剩下凑不出"
//      这类硬违反，并且**拒绝落子时不计费**，还会说清是哪条 run（规范 §1 第三条承诺）。
//   ② 提示只问 engine 的 solve —— 提示文本直接来自推导脚本里的某一条事件，
//      由那条事件的规则说出"哪条 run、把哪个格的哪个候选划掉了/定成了什么"。这里不另写一套推理。
//   ③ 笔记是玩家自己的铅笔：一个格 9 个候选位，可以逐个加、逐个删，跟已填的数字互不干扰。

import {
  ACROSS,
  DOWN,
  MAX_DIGIT,
  complete,
  diagnose,
  legalPlace,
  solve,
  verify,
} from '../engine/kakuro.js';
import { BITS, FIRST, POP, digitsOf } from '../engine/combos.js';
import { decodePuzzle } from '../engine/generate.js';

export const EMPTY = 0;

export function createState(board) {
  return {
    values: new Uint8Array(board.n),
    notes: Uint16Array.from(board.initMask),
  };
}

export class Game {
  constructor({ onUpdate = () => {}, onEvent = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onEvent = onEvent;
    this.board = null;
    this.puzzle = null;
    this.values = null;
    this.notes = null;
    this.sel = -1;
    this.mode = 'ink'; // 'ink' | 'note'
    this.history = [];
    this.moves = 0;
    this.hints = 0;
    this.rejections = 0;
    this.status = 'empty'; // empty | playing | won | stuck
    this.startedAt = 0;
    this.elapsedMs = 0;
    this.message = null;
    this.flash = null; // {cells, run, until}
    this.hintMark = null; // {cell, run, rule, digit, until}
  }

  // ---- 装卸 ----------------------------------------------------------------------------------

  load(puzzle) {
    const board = puzzle.board || decodePuzzle(puzzle.code);
    this.board = board;
    this.puzzle = { ...puzzle, board, code: puzzle.code || board };
    const st = createState(board);
    this.values = st.values;
    this.notes = st.notes;
    this.sel = board.n ? 0 : -1;
    this.history = [];
    this.moves = 0;
    this.hints = 0;
    this.rejections = 0;
    this.status = 'playing';
    this.startedAt = Date.now();
    this.elapsedMs = 0;
    this.message = null;
    this.flash = null;
    this.hintMark = null;
    this.emit('load');
    return this;
  }

  /** 从存档恢复：直接灌入墨水与笔记，不动计数以外的任何东西。 */
  restore({ code, values, notes, moves, hints, elapsedMs, status }) {
    this.load({ code });
    if (values) for (let t = 0; t < this.board.n; t++) this.values[t] = values[t] | 0;
    if (notes) for (let t = 0; t < this.board.n; t++) if (notes[t]) this.notes[t] = notes[t] | 0;
    this.moves = moves | 0;
    this.hints = hints | 0;
    this.elapsedMs = elapsedMs | 0;
    this.startedAt = Date.now() - this.elapsedMs;
    this.status = status === 'won' ? 'won' : this.checkWin() ? 'won' : 'playing';
    return this;
  }

  restart() {
    if (!this.puzzle) return this;
    const saved = this.puzzle;
    this.tick();
    return this.load(saved);
  }

  // ---- 读数 ----------------------------------------------------------------------------------

  tick() {
    if (this.status === 'playing') this.elapsedMs = Date.now() - this.startedAt;
    return this.elapsedMs;
  }

  get filled() {
    if (!this.values) return 0;
    let n = 0;
    for (const v of this.values) if (v) n++;
    return n;
  }

  diagnosis() {
    return this.board ? diagnose(this.board, this.values) : null;
  }

  /** 选中格的候选（笔记）列表；没选中返回空数组。 */
  candidatesOf(t) {
    if (t == null || t < 0 || !this.notes) return [];
    return digitsOf(this.notes[t]);
  }

  state() {
    if (!this.board) return { status: 'empty' };
    const d = this.diagnosis();
    return {
      status: this.status,
      w: this.board.w,
      h: this.board.h,
      size: `${this.board.w}×${this.board.h}`,
      cells: this.board.n,
      clues: this.board.clues,
      runs: this.board.runs.length,
      filled: this.filled,
      remaining: this.board.n - this.filled,
      satisfied: d.satisfied,
      conflicts: d.conflicts,
      moves: this.moves,
      hints: this.hints,
      rejections: this.rejections,
      ms: this.tick(),
      mode: this.mode,
      selected: this.sel,
      selectedName: this.sel >= 0 ? this.board.name(this.sel) : '',
      selectedValue: this.sel >= 0 ? this.values[this.sel] : 0,
      selectedCandidates: this.candidatesOf(this.sel),
      tier: this.puzzle && this.puzzle.tier != null ? this.puzzle.tier : null,
      tierName: this.puzzle ? this.puzzle.tierName || null : null,
      kind: this.puzzle ? this.puzzle.kind || 'random' : null,
      day: this.puzzle ? this.puzzle.day || null : null,
      chapter: this.puzzle ? this.puzzle.chapter ?? null : null,
      index: this.puzzle ? this.puzzle.index ?? null : null,
      id: this.puzzle ? this.puzzle.id || null : null,
      score: this.puzzle && this.puzzle.score != null ? this.puzzle.score : null,
      regionNeeded: this.puzzle ? !!this.puzzle.regionNeeded : false,
      message: this.message,
      won: this.status === 'won',
    };
  }

  emit(kind, extra) {
    this.onUpdate(this.state(), { kind, ...extra });
    this.onEvent(kind, extra);
  }

  // ---- 输入 ----------------------------------------------------------------------------------

  select(t) {
    if (!this.board || t < 0 || t >= this.board.n) return false;
    if (this.status === 'won') return false;
    this.sel = t;
    this.emit('select');
    return true;
  }

  selectGrid(g) {
    const t = this.board && this.board.ordinal ? this.board.ordinal[g] : -1;
    return t >= 0 ? this.select(t) : false;
  }

  setMode(mode) {
    this.mode = mode === 'note' ? 'note' : 'ink';
    this.emit('mode');
    return this.mode;
  }

  toggleMode() {
    return this.setMode(this.mode === 'note' ? 'ink' : 'note');
  }

  /** 键盘/数字盘入口。返回 {ok, why, kind}。 */
  press(digit) {
    if (!this.board || this.status !== 'playing') return { ok: false, why: '现在不能落子' };
    const t = this.sel;
    if (t < 0) return { ok: false, why: '先选一个白格' };
    if (this.mode === 'note') return this.toggleNote(digit);
    if (this.values[t] === digit) return this.clearCell();
    return this.placeInk(t, digit);
  }

  placeInk(t, digit) {
    const legal = legalPlace(this.board, this.values, t, digit);
    if (!legal.ok) {
      // 拒绝落子、不计费，并点名叫出是哪条 run
      this.rejections++;
      this.message = legal.why;
      this.flash = { run: legal.run, cells: this.runCells(legal.run), until: Date.now() + 900 };
      this.emit('reject', { reason: legal.why, run: legal.run });
      return { ok: false, why: legal.why, run: legal.run, charged: false };
    }
    this.push({ t, from: this.values[t], fromNote: this.notes[t] });
    this.values[t] = digit;
    this.notes[t] = 0;
    this.moves++;
    this.message = null;
    this.flash = null;
    this.emit('ink', { cell: t, digit });
    if (this.checkWin()) this.win();
    return { ok: true, digit };
  }

  toggleNote(digit) {
    const t = this.sel;
    if (this.values[t]) {
      this.message = `${this.board.name(t)} 已经填了 ${this.values[t]}，笔记要写在空格上`;
      this.emit('reject', { reason: this.message });
      return { ok: false, why: this.message, charged: false };
    }
    this.push({ t, from: 0, fromNote: this.notes[t], noteOnly: true });
    const bit = BITS(digit);
    this.notes[t] ^= bit;
    this.moves++;
    this.emit('note', { cell: t, digit, on: !!(this.notes[t] & bit) });
    return { ok: true, on: !!(this.notes[t] & bit) };
  }

  clearCell() {
    const t = this.sel;
    if (!this.values[t] && !this.notes[t]) return { ok: false, why: '这格本来就是空的' };
    this.push({ t, from: this.values[t], fromNote: this.notes[t] });
    this.values[t] = 0;
    this.notes[t] = this.board.initMask[t];
    this.moves++;
    this.status = this.status === 'won' ? this.status : 'playing';
    this.emit('clear', { cell: t });
    return { ok: true };
  }

  eraseNotes(t = this.sel) {
    if (t < 0 || this.values[t]) return { ok: false, why: '只有空格能清笔记' };
    this.push({ t, from: 0, fromNote: this.notes[t], noteOnly: true });
    this.notes[t] = 0;
    this.moves++;
    this.emit('note-clear', { cell: t });
    return { ok: true };
  }

  /** 把引擎算出的候选原样写成这格的铅笔标记（清笔记按钮用）。 */
  autoNotes(t = this.sel) {
    if (t < 0) return { ok: false };
    const res = solve(this.board, { seed: this.values });
    const m = res.masks ? res.masks[t] : this.board.initMask[t];
    this.push({ t, from: 0, fromNote: this.notes[t], noteOnly: true });
    this.notes[t] = this.values[t] ? 0 : m;
    this.emit('note-auto', { cell: t });
    return { ok: true, mask: m };
  }

  push(entry) {
    this.history.push({ ...entry, moves: this.moves, hints: this.hints });
    if (this.history.length > 4000) this.history.shift();
  }

  runCells(id) {
    if (id == null || !this.board || !this.board.runs[id]) return [];
    return this.board.runs[id].cells;
  }

  undo() {
    const e = this.history.pop();
    if (!e) return { ok: false, why: '没有可撤销的步子' };
    this.values[e.t] = 0;
    this.notes[e.t] = e.fromNote;
    if (e.from) this.values[e.t] = e.from;
    this.moves = e.moves;
    this.hints = e.hints;
    if (this.status === 'won') this.status = 'playing';
    this.sel = e.t;
    this.emit('undo', { cell: e.t });
    return { ok: true, cell: e.t };
  }

  // ---- 提示：直接抄推导脚本 --------------------------------------------------------------------------------

  /**
   * 下一步提示。做法：拿玩家当前的墨水当种子，重跑一遍**同一支**不猜的铅笔，
   * 取脚本里下一条对本格有信息的事件，把它的规则原文说出来。
   * 若玩家已经把自己推死（种子跑出矛盾），不收提示费，只把矛盾说清楚。
   */
  hint() {
    if (!this.board || this.status !== 'playing') return { ok: false, why: '现在不需要提示' };
    const res = solve(this.board, { seed: this.values });
    if (res.conflict) {
      this.message = `不用花提示：${res.conflict}`;
      const run = res.events.length ? res.events[res.events.length - 1].run : null;
      this.flash = { run, cells: this.runCells(run), until: Date.now() + 1200 };
      this.emit('hint-conflict', { reason: res.conflict });
      return { ok: false, why: res.conflict, charged: false };
    }
    const ev = this.pickHintEvent(res);
    if (!ev) {
      this.message = '这一局已经推到铅笔路径的尽头了，剩下的要靠已经写下的候选继续夹。';
      this.emit('hint-none', {});
      return { ok: false, why: this.message, charged: false };
    }
    const text = ev.rule.text(this.board, ev);
    this.hints++;
    this.hintMark = {
      cell: ev.cell,
      run: ev.run,
      rule: ev.rule.key,
      ruleName: ev.rule.name,
      digit: ev.kind === 'place' ? ev.digit : null,
      killed: ev.kind === 'prune' ? ev.digit : null,
      text,
      until: Date.now() + 4200,
    };
    this.message = text;
    // 提示只划候选、不代笔填数：place 类提示把该格的候选收敛成一个，让"为什么是它"看得见
    if (ev.kind === 'place' && !this.values[ev.cell]) {
      this.push({ t: ev.cell, from: 0, fromNote: this.notes[ev.cell], noteOnly: true });
      this.notes[ev.cell] = res.masks ? res.masks[ev.cell] : BITS(ev.digit);
    }
    this.sel = ev.cell;
    this.emit('hint', { cell: ev.cell, rule: ev.rule.key, text });
    return { ok: true, text, cell: ev.cell, rule: ev.rule.key, kind: ev.kind, charged: true };
  }

  pickHintEvent(res) {
    const events = res.events || [];
    if (!events.length) return null;
    const fresh = events.filter((e) => !this.values[e.cell]);
    const pool = fresh.length ? fresh : events;
    const near = pool.find((e) => e.cell === this.sel) || pool.find((e) => this.runOfSel().includes(e.run));
    return near || pool[0];
  }

  runOfSel() {
    if (this.sel < 0) return [];
    return [this.board.acrossRun[this.sel], this.board.downRun[this.sel]];
  }

  // ---- 终局 ----------------------------------------------------------------------------------

  checkWin() {
    if (!this.board) return false;
    return complete(this.board, this.values);
  }

  /** 玩家说"我填完了"：给一个不含答案的判定 + 撞破的 run 名单。 */
  check() {
    const bad = verify(this.board, this.values);
    const empty = this.board.n - this.filled;
    if (!bad.length && !empty) {
      this.win();
      return { ok: true, bad: [], empty };
    }
    const cells = new Set();
    for (const b of bad) {
      const run = b.runCellIds ? b.runCellIds : null;
      if (run) for (const t of run) cells.add(t);
    }
    this.flash = { run: null, cells: Array.from(cells), until: Date.now() + 1200 };
    this.message = bad.length ? bad[0].why : `还有 ${empty} 格空着`;
    this.emit('check', { bad, empty });
    return { ok: false, bad, empty, cells };
  }

  win() {
    this.status = 'won';
    this.tick();
    this.message = '全部对上：每条 run 的和与不重复都成立。';
    this.flash = null;
    this.emit('win', { ms: this.elapsedMs, moves: this.moves, hints: this.hints });
    return true;
  }

  /** 调试/验收用：让引擎把这一局推到底，逐格返回。UI 不拿它代替玩家。 */
  solution() {
    const res = solve(this.board);
    return res.ok ? res.values : null;
  }

  /** 键盘方向键移动选中格（行主序）。 */
  moveSelection(dr, dc) {
    if (!this.board) return false;
    const g = this.sel >= 0 ? this.board.cellOf[this.sel] : 0;
    let r = Math.floor(g / this.board.w);
    let c = g % this.board.w;
    for (let step = 0; step < Math.max(this.board.w, this.board.h); step++) {
      r = (r + dr + this.board.h) % this.board.h;
      c = (c + dc + this.board.w) % this.board.w;
      const t = this.board.ordinal[r * this.board.w + c];
      if (t >= 0) return this.select(t);
    }
    return false;
  }

  /** 供存档：把当前局面压成可回放的形状。 */
  serializable() {
    return {
      code: this.puzzle.code,
      values: Array.from(this.values),
      notes: Array.from(this.notes),
      moves: this.moves,
      hints: this.hints,
      ms: this.elapsedMs,
      status: this.status,
    };
  }
}

export { MAX_DIGIT, ACROSS, DOWN, FIRST, POP };
