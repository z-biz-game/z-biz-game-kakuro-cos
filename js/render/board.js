// 画布渲染。一块 canvas、一次绘制、无图片无字体文件。
//
// 版式上的两个硬规定（README 规则原文）：黑格里的两个数字，**右上**是"这格下面那一竖串"的和、
// **右下**是"这格右边那一横串"的和，中间一条左上→右下对角线分开。白格里要么是 1..9 的大数字
// （等宽字），要么是玩家自己的铅笔标记（3×3 定位、逐个可删），两者不同时出现——填了数就清笔记。
//
// 布局算法单独抽成 layoutFor()，因为它同时被三处使用：绘制、命中测试、以及验证台按几何算像素点
// （tools/scenarios.js 靠它把"第几格"换算成画布坐标来取色）。

import { ACROSS, DOWN } from '../engine/kakuro.js';
import { BITS, POP, digitsOf } from '../engine/combos.js';
import { Cell, Font, Radius, readVars, rgba } from '../theme.js';

export const PAD = 6;

/** 给定可视宽度算出格径与画布尺寸。触摸目标优先保 44，大盘在窄屏上让路（会在 DOM 上标出来）。 */
export function layoutFor({ w, h, avail = 520, maxCell = 58, minCell = 26 }) {
  const inner = Math.max(160, avail - PAD * 2);
  let cell = Math.floor(inner / Math.max(w, h));
  if (cell > maxCell) cell = maxCell;
  if (cell < minCell) cell = minCell;
  const size = cell * Math.max(w, h);
  return {
    w,
    h,
    cell,
    pad: PAD,
    width: size + PAD * 2,
    height: size + PAD * 2,
    boardW: cell * w,
    boardH: cell * h,
    touch: cell >= Cell.minTouch,
    digitPx: Math.round(cell * Cell.digitRatio),
    cluePx: Math.max(8, Math.round(cell * Cell.clueRatio)),
    notePx: Math.max(7, Math.round(cell * Cell.noteRatio)),
  };
}

export class BoardView {
  constructor(canvas, { getGame, getUi } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getGame = getGame;
    this.getUi = getUi || (() => ({}));
    this.layout = null;
    this.dpr = 1;
    this.anim = null;
    this.dirty = true;
    this.pulse = 0;
  }

  resize(avail) {
    const g = this.getGame();
    if (!g || !g.board) return;
    const { w, h } = g.board;
    const layout = layoutFor({ w, h, avail });
    this.layout = layout;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.canvas.style.width = `${layout.width}px`;
    this.canvas.style.height = `${layout.height}px`;
    this.canvas.width = Math.round(layout.width * this.dpr);
    this.canvas.height = Math.round(layout.height * this.dpr);
    this.markDirty();
  }

  markDirty() {
    this.dirty = true;
    if (!this.anim) this.anim = requestAnimationFrame(() => this.frame());
  }

  frame(now) {
    this.anim = null;
    this.draw(now);
  }

  /** 等一次真正的绘制落地（验证台用：它要读像素，不能读半张图）。 */
  settled() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        this.draw();
        requestAnimationFrame(() => resolve(this.layoutSnapshot()));
      });
    });
  }

  layoutSnapshot() {
    const l = this.layout || { cell: 0, w: 0, h: 0, pad: PAD };
    const rect = this.canvas.getBoundingClientRect();
    return {
      cell: l.cell,
      w: l.w,
      h: l.h,
      pad: l.pad,
      dpr: this.dpr,
      cssWidth: Math.round(rect.width),
      cssHeight: Math.round(rect.height),
      backingWidth: this.canvas.width,
      backingHeight: this.canvas.height,
      touch: l.touch,
    };
  }

  cellRect(grid) {
    const l = this.layout;
    const g = this.getGame();
    const w = g.board.w;
    const r = Math.floor(grid / w);
    const c = grid % w;
    return { x: l.pad + c * l.cell, y: l.pad + r * l.cell, size: l.cell };
  }

  /** 画布 CSS 坐标 → 网格下标（黑格也返回，由调用方判色）。 */
  hitTest(x, y) {
    const l = this.layout;
    if (!l) return null;
    const g = this.getGame();
    const c = Math.floor((x - l.pad) / l.cell);
    const r = Math.floor((y - l.pad) / l.cell);
    if (c < 0 || r < 0 || c >= g.board.w || r >= g.board.h) return null;
    return { grid: r * g.board.w + c, r, c, rect: this.cellRect(r * g.board.w + c) };
  }

  // ---- 绘制 ----------------------------------------------------------------------------------

  draw(now = Date.now()) {
    const g = this.getGame();
    if (!g || !g.board || !this.layout) return;
    const ctx = this.ctx;
    const C = readVars(this.canvas.parentElement || document.documentElement);
    const l = this.layout;
    const board = g.board;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, l.width, l.height);
    ctx.fillStyle = C.paper;
    roundRect(ctx, 0.5, 0.5, l.width - 1, l.height - 1, Radius.card);
    ctx.fill();

    const sel = g.sel;
    const selRuns = sel >= 0 ? [board.acrossRun[sel], board.downRun[sel]] : [];
    const flash = g.flash && g.flash.until > now ? g.flash : null;
    const flashCells = flash ? new Set(flash.cells) : null;
    const hint = g.hintMark && g.hintMark.until > now ? g.hintMark : null;
    const ui = this.getUi();
    const showAllNotes = !ui.hideNotes;

    for (let t = 0; t < board.size; t++) {
      const rect = this.cellRect(t);
      const black = board.black[t] === 1;
      if (black) this.drawBlack(ctx, board, t, rect, C);
      else this.drawWhite(ctx, g, board.ordinal[t], rect, C, { selRuns, flashCells, hint, showAllNotes, now });
    }

    this.drawGrid(ctx, board, l, C);
    ctx.restore();
    this.dirty = false;
  }

  drawBlack(ctx, board, t, rect, C) {
    const { x, y, size } = rect;
    ctx.fillStyle = C.gridStrong;
    ctx.fillRect(x, y, size, size);
    const ac = board.across[t];
    const dn = board.down[t];
    ctx.strokeStyle = rgba('#ffffff', 0.22);
    ctx.lineWidth = Math.max(1, size / 26);
    ctx.beginPath();
    ctx.moveTo(x + size * 0.06, y + size * 0.06);
    ctx.lineTo(x + size * 0.94, y + size * 0.94);
    ctx.stroke();
    ctx.fillStyle = C.paper;
    ctx.font = Font.clue(this.layout.cluePx);
    ctx.textBaseline = 'middle';
    if (dn) {
      // 纵向 run 的和：写在黑格**右上**
      ctx.textAlign = 'right';
      ctx.fillText(String(dn), x + size * 0.94, y + size * (0.25 + Cell.clueOffset));
    }
    if (ac) {
      // 横向 run 的和：写在黑格**右下**
      ctx.textAlign = 'right';
      ctx.fillText(String(ac), x + size * 0.94, y + size * (0.78 - Cell.clueOffset));
    }
  }

  drawWhite(ctx, g, ord, rect, C, st) {
    const { x, y, size } = rect;
    const board = g.board;
    const inRun = st.selRuns.includes(board.acrossRun[ord]) || st.selRuns.includes(board.downRun[ord]);
    let bg = (Math.floor(rect.y / size) + Math.floor(rect.x / size)) % 2 ? C.tileAlt : C.tile;
    if (inRun) bg = C.runGlow;
    if (st.flashCells && st.flashCells.has(ord)) bg = rgba(C.danger, 0.24);
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, size, size);
    const value = g.values[ord];
    const centered = st.hint && st.hint.cell === ord;
    if (value) {
      const conflict = st.hint && st.hint.cell === ord;
      ctx.fillStyle = conflict ? C.hint : C.ink;
      ctx.font = Font.digit(this.layout.digitPx);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(value), x + size / 2, y + size / 2 + size * 0.02);
      return;
    }
    if (centered) {
      ctx.fillStyle = rgba(C.hint, 0.18);
      ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
    }
    if (ord === g.sel) {
      ctx.fillStyle = rgba(C.selected, 0.75);
      ctx.fillRect(x, y, size, size);
    }
    const mask = g.notes[ord];
    if (!mask || !st.showAllNotes) return;
    const list = digitsOf(mask);
    if (!list.length) return;
    ctx.fillStyle = ord === g.sel ? C.ink : C.note;
    ctx.font = Font.note(this.layout.notePx);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const slot = size / 3;
    for (const d of list) {
      const i = d - 1;
      const cx = x + (i % 3) * slot + slot / 2;
      const cy = y + Math.floor(i / 3) * slot + slot / 2;
      ctx.fillText(String(d), cx, cy);
    }
  }

  /** 网格线：run 的外框加粗，内部细线。这是"哪些格属于同一条 run"的可视答案。 */
  drawGrid(ctx, board, l, C) {
    const { w, h, cell, pad } = l;
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    for (let r = 0; r <= h; r++) {
      for (let c = 0; c < w; c++) {
        const up = r > 0 && board.black[(r - 1) * w + c] === 1;
        const cur = r < h && board.black[r * w + c] === 1;
        if (cur === up) continue; // 同一条 run 内部不画粗线
        ctx.moveTo(pad + c * cell, pad + r * cell);
        ctx.lineTo(pad + (c + 1) * cell, pad + r * cell);
      }
    }
    for (let c = 0; c <= w; c++) {
      for (let r = 0; r < h; r++) {
        const left = c > 0 && board.black[r * w + c - 1] === 1;
        const cur = c < w && board.black[r * w + c] === 1;
        if (cur === left) continue;
        ctx.moveTo(pad + c * cell, pad + r * cell);
        ctx.lineTo(pad + c * cell, pad + (r + 1) * cell);
      }
    }
    ctx.stroke();
    ctx.strokeStyle = C.gridStrong;
    ctx.lineWidth = 2;
    ctx.strokeRect(pad, pad, cell * w, cell * h);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { ACROSS, DOWN, BITS, POP, Radius };
