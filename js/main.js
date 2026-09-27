// 接线层：DOM、指针、键盘、时钟、存档，以及验证台要用的 window.kakuro。
//
// 这里**一条规则都不写**。所有关于"这一格能不能落子""下一步推得出什么"的判断都从
// js/engine/kakuro.js 经 js/ui/game.js 上来；棋盘画什么由 js/render/board.js 决定。
// 之所以能这么绝对，是因为 solve() 一次都不猜：提示、验收、出题用的是同一个函数。
//
// 主题刻度的分工也在这里钉死：颜色只在 css/game.css 里出现（board.js 用 readVars 把同一批
// 变量读进画布），间距/圆角/时长/字号由 js/theme.js 的常量经 applyThemeVars() 写给 CSS ——
// 于是"把触摸目标改成 44"这种事只有一处可改，改两处就会分裂。

import { Cell, Motion, Radius, Space, applyThemeVars } from './theme.js';
import { isMuted, play, setMuted, unlockAudio } from './audio/synth.js';
import { createStore, encodeNotes, rleDecode, rleEncode, decodeNotes } from './store.js';
import { TIERS, tierFor } from './engine/generate.js';
import * as Engine from './engine/kakuro.js';
import * as Combos from './engine/combos.js';
import * as Count from './engine/count.js';
import { BoardView } from './render/board.js';
import { Game } from './ui/game.js';
import {
  CHAPTERS,
  PUZZLES,
  chapterDone,
  chapterUnlocked,
  dailyFor,
  decodePuzzle,
  nextPuzzle,
  puzzlesOfChapter,
  randomPuzzle,
  summary,
} from './library.js';

const VERSION = '1.0.0';

const $ = (sel) => document.querySelector(sel);
const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  chapters: $('#chapter-list'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  progress: $('#progress-card'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  size: $('#stat-size'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  rejects: $('#stat-rejects'),
  filled: $('#stat-filled'),
  remaining: $('#stat-remaining'),
  satisfied: $('#stat-satisfied'),
  conflicts: $('#stat-conflicts'),
  score: $('#stat-score'),
  cell: $('#stat-cell'),
  cands: $('#stat-cands'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  stateLine: $('#state-line'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winRecord: $('#win-record'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
  keypad: $('#keypad'),
  modeInk: $('#btn-mode-ink'),
  modeNote: $('#btn-mode-note'),
  notesBtn: $('#btn-notes'),
  soundBtn: $('#btn-sound'),
};

const store = createStore();
store.load();
const options = () => store.state.options;

let game = null;
let view = null;
let ticker = 0;
let pulseUntil = 0;
let raf = 0;
let lastKind = 'tap';

// ---- 主题：把 js/theme.js 的刻度写给 CSS 用 ---------------------------------------------------

function pushThemeVars() {
  applyThemeVars(document.documentElement, {
    'space-panel': `${Space.panel}px`,
    'space-block': `${Space.block}px`,
    'space-item': `${Space.item}px`,
    'space-tight': `${Space.tight}px`,
    'radius-panel': `${Radius.panel}px`,
    'radius-card': `${Radius.card}px`,
    'radius-control': `${Radius.control}px`,
    'radius-chip': `${Radius.chip}px`,
    'min-touch': `${Cell.minTouch}px`,
    spring: Motion.spring,
    ease: Motion.ease,
    'dur-tap': `${Motion.tapMs}ms`,
    'dur-hint': `${Motion.hintMs}ms`,
    'dur-pulse': `${Motion.pulseMs}ms`,
  });
}

// ---- 题目 → game.load 需要的形状 ---------------------------------------------------------------

/** 三种出题路（章节 / 日课 / 现抽）返回的形状不一样，这里统一成 state() 要的字段。 */
function normalize(source) {
  const meta = source.meta || {};
  const code = source.code || (source.board && Engine.encodeBoard(source.board));
  return {
    ...source,
    code,
    board: source.board || decodePuzzle(code),
    kind: source.kind || 'chapter',
    id: source.id || `c${meta.chapter ?? source.chapter ?? 0}p${meta.index ?? source.index ?? 0}`,
    tier: source.tier ?? meta.tier ?? 0,
    tierName: source.tierName || TIERS[source.tier ?? meta.tier ?? 0].name,
    chapter: source.chapter === undefined ? meta.chapter ?? null : source.chapter,
    index: source.index === undefined ? meta.index ?? null : source.index,
    day: source.day || null,
    score: source.score ?? meta.score ?? null,
    regionNeeded: !!(source.regionNeeded ?? meta.needsRegion),
  };
}

// ---- 绘制与尺寸 ------------------------------------------------------------------------------

function availWidth() {
  const narrow = window.innerWidth <= 900;
  const stage = el.viewGame.hidden ? window.innerWidth - 80 : (el.viewGame.clientWidth || window.innerWidth) - 380;
  return Math.max(260, Math.min(narrow ? window.innerWidth - 48 : stage, 620));
}

function relayout() {
  if (!game || !game.board || !view) return;
  view.resize(availWidth());
  const l = view.layout;
  el.canvas.dataset.touch = l && l.touch ? '1' : '0';
}

function paint() {
  if (!view) return;
  view.draw();
  schedulePulse();
}

/** 提示高亮与被拒的 run 都要淡出：只在这些标记活着的时候继续要帧。 */
function schedulePulse() {
  const now = Date.now();
  const live = (game && game.flash && game.flash.until > now) || (game && game.hintMark && game.hintMark.until > now);
  if (!live) {
    pulseUntil = 0;
    return;
  }
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (Date.now() < pulseUntil + 16) return;
    pulseUntil = Date.now();
    if (view) view.draw(pulseUntil);
    schedulePulse();
  });
}

// ---- 读数：一个地方写，别处只读 ----------------------------------------------------------------

function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = st.day ? `日课 ${st.day}` : st.chapter != null ? `第${st.chapter + 1}章 第${st.index + 1}局` : `${st.kind === 'pool' ? '烘焙池' : '现抽'}一局`;
  el.tier.textContent = st.tierName || '—';
  el.tier.dataset.tier = String(st.tier);
  el.size.textContent = st.size;
  el.time.textContent = fmtMs(st.ms);
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.rejects.textContent = st.rejections;
  el.filled.textContent = `${st.filled}/${st.cells}`;
  el.remaining.textContent = st.remaining;
  el.satisfied.textContent = `${st.satisfied}/${st.runs}`;
  el.conflicts.textContent = st.conflicts;
  el.score.textContent = st.score == null ? '—' : Number(st.score).toFixed(1);
  el.cell.textContent = st.selectedName || '—';
  el.cands.textContent = st.selectedCandidates.length ? st.selectedCandidates.join(' ') : st.selectedValue ? String(st.selectedValue) : '—';
  setClass(el.rejects.closest('.stat'), 'bad', st.rejections > 0 && st.status !== 'won');
  setClass(el.conflicts.closest('.stat'), 'bad', st.conflicts > 0);
  setClass(el.satisfied.closest('.stat'), 'good', st.status === 'won');
  setClass(el.remaining.closest('.stat'), 'bad', st.status !== 'won' && st.conflicts > 0);
  el.stateLine.className = 'conflict-line' + (st.conflicts ? '' : st.message ? ' note' : st.won ? ' good' : '');
  el.stateLine.textContent = st.conflicts
    ? `${st.conflicts} 条 run 已经被撞破：${st.message || '不是和超了就是同一个数字用了两遍。撤销一步再想。'}`
    : st.message || '';
  if (game.hintMark && game.hintMark.until > Date.now()) {
    el.hintRule.textContent = `规则：${game.hintMark.ruleName}`;
    el.hintLine.textContent = game.hintMark.text;
  }
  syncKeypad(st);
}

function setClass(node, name, on) {
  if (node) node.classList.toggle(name, !!on);
}

function syncKeypad(st) {
  for (const btn of el.keypad.querySelectorAll('.pad-key')) {
    const d = Number(btn.dataset.digit);
    const on = game.mode === 'note' ? st.selectedCandidates.includes(d) : st.selectedValue === d;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

function fmtMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function syncAll() {
  syncStats();
  relayout();
  paint();
}

// ---- 存档 ------------------------------------------------------------------------------------

function flushResume() {
  if (!game || game.status === 'won') return;
  game.tick();
  store.setResume({
    code: game.puzzle.code,
    ink: rleEncode(game.values),
    notes: encodeNotes(game.notes),
    moves: game.moves,
    hints: game.hints,
    ms: game.elapsedMs,
    status: game.status,
    kind: game.puzzle.kind,
    day: game.puzzle.day || '',
    tier: game.puzzle.tier,
    chapter: game.puzzle.chapter == null ? -1 : game.puzzle.chapter,
    index: game.puzzle.index == null ? -1 : game.puzzle.index,
  });
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function onWin() {
  stopClock();
  const ms = game.elapsedMs;
  const id = game.puzzle.id;
  const before = store.state.best[id];
  store.recordFinish(id, { moves: game.moves, hints: game.hints, ms, date: todayKey() });
  const isRecord = store.state.best[id] !== before;
  if (game.puzzle.chapter != null) {
    const list = store.markChapter(game.puzzle.chapter, id);
    const full = list.length >= puzzlesOfChapter(game.puzzle.chapter).length;
    el.winMeta.textContent = `${game.puzzle.tierName} · ${game.board.w}×${game.board.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次｜本章 ${list.length}/${puzzlesOfChapter(game.puzzle.chapter).length}`;
    if (full) {
      play('chapter');
      el.winRecord.textContent = '本章打完，下一章解锁。';
    } else {
      el.winRecord.textContent = isRecord ? '新纪录：这一局比存档里更不求人。' : '未破纪录：先比提示次数。';
      play('win');
    }
  } else {
    el.winMeta.textContent = `${game.puzzle.tierName} · ${game.board.w}×${game.board.h} · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
    el.winRecord.textContent = isRecord ? '新纪录。' : '未破纪录：先比提示次数。';
    play('win');
  }
  if (game.puzzle.kind === 'daily' && game.puzzle.day) {
    store.recordDaily(game.puzzle.day, { tier: game.puzzle.tier, moves: game.moves, hints: game.hints, ms, id });
  }
  store.setResume(null);
  el.winVeil.hidden = false;
  syncStats();
  renderMenu();
}

// ---- 时钟 ------------------------------------------------------------------------------------

function startClock() {
  clearInterval(ticker);
  ticker = setInterval(() => {
    if (game && game.status === 'playing') el.time.textContent = fmtMs(game.tick());
  }, 1000);
}

function stopClock() {
  clearInterval(ticker);
  ticker = 0;
  if (game) game.tick();
}

// ---- 开局 ------------------------------------------------------------------------------------

function start(puzzleLike, { resume = null } = {}) {
  const puzzle = normalize(puzzleLike);
  if (!game) {
    game = new Game({
      onUpdate: () => syncAll(),
      onEvent: (kind) => onGameEvent(kind),
    });
    view = new BoardView(el.canvas, { getGame: () => game, getUi: () => ({ hideNotes: !!options().hideNotes }) });
    bindCanvas();
  }
  el.winVeil.hidden = true;
  // 存档里的用时字段叫 ms，restore() 收的是 elapsedMs：不映射过去，刷新就白送一个归零计时。
  if (resume) game.restore({ ...resume, elapsedMs: Number(resume.elapsedMs ?? resume.ms) | 0 });
  else game.load(puzzle);
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
  }
  game.setMode('ink');
  setModeButtons();
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.textContent = '按 提示 会说出当前能推的一格，以及它依据哪条规则。你自己已经写下、且和线索矛盾的数字，提示会拒绝落子也不计费。';
  syncAll();
  flushResume();
  return game;
}

function onGameEvent(kind) {
  const map = {
    ink: 'tap',
    note: 'note',
    'note-clear': 'erase',
    'note-auto': 'note',
    clear: 'erase',
    reject: 'reject',
    hint: 'hint',
    'hint-conflict': 'reject',
    undo: 'undo',
    win: 'win',
    check: 'tap',
  };
  const sound = map[kind];
  if (sound) play(sound);
  if (kind === 'win') onWin();
  if (kind !== 'load' && kind !== 'select') flushResume();
  lastKind = kind;
}

// ---- 视图切换与菜单 ---------------------------------------------------------------------------

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    stopClock();
    flushResume();
    renderMenu();
  }
  if (which === 'game') {
    relayout();
    paint();
  }
  document.body.dataset.view = which;
  return which;
}

function renderMenu() {
  renderChapters();
  renderTiers();
  renderRecords();
  renderProgress();
  renderResumeCard();
}

function renderChapters() {
  el.chapters.innerHTML = '';
  for (const c of CHAPTERS) {
    const unlocked = chapterUnlocked(store, c.idx);
    const done = Math.min(chapterDone(store, c.idx), c.size);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chapter' + (unlocked ? '' : ' locked') + (done >= c.size && c.size ? ' done' : '');
    b.dataset.chapter = String(c.idx);
    b.disabled = !unlocked;
    const band = TIERS[c.tier].band;
    b.innerHTML =
      `<span><span class="ch-name">${c.name}</span><br><span class="ch-note">${c.blurb}</span></span>` +
      `<span class="ch-meta">${unlocked ? `已解 ${done}/${c.size}<br>${c.size}格实测 ${band[0]}–${band[1]}` : '未解锁<br>打完上一章'}</span>`;
    b.addEventListener('click', () => {
      const list = puzzlesOfChapter(c.idx);
      const solved = new Set(store.state.chapters[c.idx] || []);
      const next = list.find((p) => !solved.has(p.id)) || list[0];
      if (next) start(next);
    });
    el.chapters.appendChild(b);
  }
}

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const T of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = String(T.idx);
    b.innerHTML =
      `<span><span class="tier-name">现抽 · ${T.name}</span><br><span class="tier-note">${T.live ? '浏览器现场出题' : '从烘焙好的池子里取（现场抽要几十秒）'}</span></span>` +
      `<span class="tier-meta">${T.w}×${T.h} 实测 ${T.band[0]}–${T.band[1]}</span>`;
    b.addEventListener('click', () => beginRandom(T.idx));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const c of CHAPTERS) {
    const list = puzzlesOfChapter(c.idx);
    let best = null;
    let solved = 0;
    for (const p of list) {
      const e = store.state.best[p.id];
      if (!e) continue;
      solved++;
      const key = [e.hints, e.moves, e.ms];
      if (!best || cmp(key, best) < 0) best = key;
    }
    const li = document.createElement('li');
    li.dataset.chapter = String(c.idx);
    li.innerHTML =
      `<b>${c.name}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best[2])}</span> · 提示 ${best[0]} · ${best[1]} 步<br><span>${solved}/${list.length} 局有纪录</span>`
        : `<span>还没有纪录（已解 ${solved}/${list.length}）</span>`);
    el.records.appendChild(li);
  }
}

const cmp = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2]);

function renderProgress() {
  const s = summary(store, todayKey());
  el.progress.innerHTML =
    `<div><span>章节 / 局数</span><b>${s.chapters} / ${s.puzzles}</b></div>` +
    `<div><span>已解</span><b>${s.done}</b></div>` +
    `<div><span>解锁到第几章</span><b>${s.unlocked}</b></div>` +
    `<div><span>日课天数</span><b>${s.dailyDone}</b></div>` +
    `<div><span>连击</span><b>${s.streak}</b></div>` +
    `<div><span>烘焙读数</span><b>${s.baked.puzzles} 局 · 分数 ${s.baked.minScore}–${s.baked.maxScore}</b></div>`;
}

function renderResumeCard() {
  const r = store.state.resume;
  const live = game && game.status !== 'won' && !el.viewGame.hidden;
  if (!r || (live && r.code && game.puzzle.code && r.code.bl === game.puzzle.code.bl)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  const T = tierFor(r.tier);
  el.resumeName.textContent = `继续 ${T.name} 的一局（${r.code.w}×${r.code.h}）`;
  el.resumeMeta.textContent = `${fmtMs(r.ms)} · ${r.moves} 步 · 提示 ${r.hints} 次 · ${r.status === 'won' ? '已解开' : '没打完'}`;
}

// ---- 出题入口 ---------------------------------------------------------------------------------

function beginRandom(tier) {
  try {
    start(randomPuzzle(tier, store));
  } catch (e) {
    el.stateLine.textContent = `这一档现场没抽到符合 band 的盘：${e.message}`;
    show('game');
  }
}

function beginDaily() {
  start(dailyFor(new Date()));
}

function resumeSaved() {
  const r = store.state.resume;
  if (!r) return false;
  start({ code: r.code, tier: r.tier }, { resume: r });
  return true;
}

// ---- 输入：画布 -------------------------------------------------------------------------------

function bindCanvas() {
  el.canvas.addEventListener('pointerdown', (ev) => {
    if (!game || !view.layout) return;
    ev.preventDefault();
    unlockAudio();
    const rect = el.canvas.getBoundingClientRect();
    const hit = view.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!hit) return;
    if (game.board.black[hit.grid]) return; // 黑格只是写着和，不是能填的格子
    game.selectGrid(hit.grid);
  });
  el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

function buildKeypad() {
  el.keypad.innerHTML = '';
  for (let d = 1; d <= Engine.MAX_DIGIT; d++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pad-key';
    b.dataset.digit = String(d);
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `${d}<small>按 ${d}</small>`;
    b.addEventListener('click', () => press(d));
    el.keypad.appendChild(b);
  }
}

// ---- 输入：动作 --------------------------------------------------------------------------------

function press(digit) {
  if (!game) return null;
  unlockAudio();
  const r = game.press(digit);
  if (r && !r.ok && r.why) syncAll();
  return r;
}

function hint() {
  if (!game) return null;
  return game.hint();
}

function undo() {
  if (!game) return null;
  return game.undo();
}

// ---- 绑定 ------------------------------------------------------------------------------------

el.modeInk.addEventListener('click', () => {
  game && game.setMode('ink');
  setModeButtons();
});
el.modeNote.addEventListener('click', () => {
  game && game.setMode('note');
  setModeButtons();
});
function setModeButtons() {
  const note = !!(game && game.mode === 'note');
  el.modeInk.setAttribute('aria-pressed', String(!note));
  el.modeNote.setAttribute('aria-pressed', String(note));
}

$('#btn-hint').addEventListener('click', hint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-check').addEventListener('click', () => game && game.check());
$('#btn-erase').addEventListener('click', () => game && game.clearCell());
$('#btn-fill-notes').addEventListener('click', () => game && game.autoNotes());
$('#btn-new').addEventListener('click', () => (game ? start(buildAgain()) : null));
$('#btn-again').addEventListener('click', () => (game ? start(buildAgain()) : null));
$('#btn-menu').addEventListener('click', () => show('menu'));
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-daily').addEventListener('click', beginDaily);
$('#btn-resume').addEventListener('click', () => resumeSaved());
$('#btn-reset').addEventListener('click', () => {
  store.reset();
  game = null;
  applySettings();
  show('menu');
});

/** 「换一局」：章节里就往后走一格，其它入口在同一档重抽。 */
function buildAgain() {
  const p = game && game.puzzle;
  if (p && p.chapter != null) {
    const list = puzzlesOfChapter(p.chapter);
    const at = (p.index + 1) % list.length;
    return list[at];
  }
  return randomPuzzle(p ? p.tier : options().tier, store);
}

el.soundBtn.addEventListener('click', () => {
  const next = !isMuted();
  setMuted(next);
  store.setOptions({ muted: next });
  applySettings();
  if (!next) play('tap');
});

el.notesBtn.addEventListener('click', () => {
  store.setOptions({ hideNotes: !options().hideNotes });
  applySettings();
  paint();
});

window.addEventListener('keydown', (ev) => {
  if (ev.target && /input|textarea/i.test(ev.target.tagName)) return;
  const k = ev.key;
  if (/^[1-9]$/.test(k)) {
    press(Number(k));
    ev.preventDefault();
  } else if (k === 'Backspace' || k === 'Delete' || k === '0') {
    game && game.clearCell();
    ev.preventDefault();
  } else if (k === 'n' || k === 'N') {
    game && game.toggleMode();
    setModeButtons();
  } else if (k === 'h' || k === 'H') hint();
  else if (k === 'z' || k === 'Z') undo();
  else if (k === 'c' || k === 'C') game && game.check();
  else if (k === 'ArrowUp') game && game.moveSelection(-1, 0);
  else if (k === 'ArrowDown') game && game.moveSelection(1, 0);
  else if (k === 'ArrowLeft') game && game.moveSelection(0, -1);
  else if (k === 'ArrowRight') game && game.moveSelection(0, 1);
  else return;
  unlockAudio();
});

window.addEventListener('resize', () => {
  relayout();
  paint();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

function applySettings() {
  setMuted(!!options().muted);
  el.soundBtn.setAttribute('aria-pressed', String(!options().muted));
  el.soundBtn.textContent = options().muted ? '音效 关' : '音效 开';
  el.notesBtn.setAttribute('aria-pressed', String(!!options().hideNotes));
  el.notesBtn.textContent = options().hideNotes ? '铅笔 藏' : '铅笔 显';
  store.setOptions({ tier: options().tier });
}

// ---- 起局 ------------------------------------------------------------------------------------

pushThemeVars();
buildKeypad();
applySettings();
renderMenu();
show('menu');
if (store.state.resume) {
  // 有存档就直接把那一局摆回屏幕上：resume 只有"继续"一个入口，不擅自开局
  renderResumeCard();
}

// ---- 交给验证台 -------------------------------------------------------------------------------

window.kakuro = {
  version: VERSION,
  store,
  options,
  get game() {
    return game;
  },
  get view() {
    return view;
  },
  show,
  start,
  beginRandom,
  beginDaily,
  resumeSaved,
  press,
  hint,
  undo,
  check: () => (game ? game.check() : null),
  selectGrid: (g) => (game ? game.selectGrid(g) : false),
  setMode: (m) => {
    if (!game) return null;
    game.setMode(m);
    setModeButtons();
    return game.mode;
  },
  buildAgain,
  renderMenu,
  syncAll,
  elapsed: () => (game ? game.tick() : 0),
  state: () => (game ? { ...game.state(), elapsedMs: game.tick() } : null),
  hitAt: (x, y) => (view && view.layout ? view.hitTest(x, y) : null),
  layout: () => (view ? view.layoutSnapshot() : null),
  cellRect: (grid) => (view ? view.cellRect(grid) : null),
  settled: () => (view ? view.settled() : null),
  puzzleById: (id) => PUZZLES.find((p) => p.id === id) || null,
  engine: {
    ...Engine,
    ...Combos,
    ...Count,
    TIERS,
    tierFor,
    CHAPTERS,
    LEVELS: PUZZLES,
    Game,
    BoardView,
    createStore,
    rleEncode,
    rleDecode,
    encodeNotes,
    decodeNotes,
  },
};
