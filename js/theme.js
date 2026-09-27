// 视觉常量。颜色一律走 CSS 变量，这样 css/game.css 改一个变量就能整站换肤；
// 画布这边只是把同一批变量读进来用，不另存一份硬编码副本。

export const Palette = {
  ink: '--ink',
  paper: '--paper',
  tile: '--tile',
  tileAlt: '--tile-alt',
  grid: '--grid',
  gridStrong: '--grid-strong',
  accent: '--accent',
  warn: '--warn',
  danger: '--danger',
  hint: '--hint',
  note: '--note',
  dim: '--dim',
  selected: '--selected',
  runGlow: '--run-glow',
};

// 规范 §2 的间距/圆角刻度：面板 20、区块 16、元素 12；圆角 20/12/8/6。
export const Space = {
  panel: 20,
  block: 16,
  item: 12,
  tight: 8,
};

export const Radius = {
  panel: 20,
  card: 12,
  control: 8,
  chip: 6,
};

export const Font = {
  ui: '-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  mono: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
  digit: (px) => `600 ${px}px ${Font.mono}`,
  clue: (px) => `600 ${px}px ${Font.mono}`,
  note: (px) => `500 ${px}px ${Font.mono}`,
  label: (px) => `500 ${px}px ${Font.ui}`,
};

// 弹簧曲线：落子和选中缩放都用它，规范里点名的那一条。
export const Motion = {
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  tapMs: 180,
  hintMs: 900,
  pulseMs: 1400,
};

// 格子里的字号刻度：数字大、线索小、笔记更小，三级都要在 44px 的触摸目标里读得清。
export const Cell = {
  minTouch: 44,
  digitRatio: 0.6,
  clueRatio: 0.31,
  noteRatio: 0.2,
  pad: 2,
  // 黑格的对角分割线：右上写纵向和、右下写横向和（README 规则原文的口径）
  clueOffset: 0.03,
};

export function readVars(el) {
  const cs = getComputedStyle(el);
  const get = (name, fallback) => {
    const v = cs.getPropertyValue(name);
    return v && v.trim() ? v.trim() : fallback;
  };
  return {
    ink: get(Palette.ink, '#12161d'),
    paper: get(Palette.paper, '#f5f1e8'),
    tile: get(Palette.tile, '#ffffff'),
    tileAlt: get(Palette.tileAlt, '#f0ece1'),
    grid: get(Palette.grid, '#c9c2b2'),
    gridStrong: get(Palette.gridStrong, '#4a4437'),
    accent: get(Palette.accent, '#1f6feb'),
    warn: get(Palette.warn, '#b26a00'),
    danger: get(Palette.danger, '#c0392b'),
    hint: get(Palette.hint, '#7b61ff'),
    note: get(Palette.note, '#7d8794'),
    dim: get(Palette.dim, '#8b8578'),
    selected: get(Palette.selected, '#ffe9a8'),
    runGlow: get(Palette.runGlow, '#dfeaff'),
  };
}

/** 把主题变量写回 :root，供 CSS 一侧使用（同一份常量的唯一来源）。 */
export function applyThemeVars(root = document.documentElement, vars = {}) {
  for (const [k, v] of Object.entries(vars)) {
    const name = k.startsWith('--') ? k : `--${k}`;
    root.style.setProperty(name, v);
  }
}

export function rgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function mixHex(a, b, t) {
  const pa = parseInt(a.replace('#', ''), 16);
  const pb = parseInt(b.replace('#', ''), 16);
  const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
  const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
  const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
