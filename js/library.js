// 章节 / 日课 / 纪录的账本。这里只有"哪一章解到哪一局"，没有题目本体 ——
// 题目本体在 js/data/levels.js，由 tools/bake.mjs 在构建期烘焙出来（连同每一局的答案）。
//
// 解锁不看任何"已通过"标志位，只看存档里真正解完的局数：chapterUnlocked() 每次都从
// store.chapters 现算。这样即便有人手改存档把第 3 章标成完成，他也只能跳到第 4 章 ——
// 而第 4 章的每一局照样要真解一遍才有纪录。

import { LEVELS, BAKE } from './data/levels.js';
import { TIERS, makePuzzle, decodePuzzle, puzzleId } from './engine/generate.js';
import { dateSeed } from './engine/rng.js';

export const CHAPTERS = TIERS.map((T, i) => ({
  idx: i,
  key: T.key,
  name: `第${['一', '二', '三', '四', '五'][i]}章 · ${T.name}`,
  tier: i,
  size: LEVELS.filter((l) => l.chapter === i).length,
  blurb: T.blurb,
  live: T.live,
}));

export const PUZZLES = LEVELS.map((l) => ({
  ...l,
  unlockedByDefault: false,
}));

export function puzzlesOfChapter(idx) {
  return PUZZLES.filter((p) => p.chapter === idx);
}

export function puzzleById(id) {
  return PUZZLES.find((p) => p.id === id) || null;
}

export function chapterDone(store, idx) {
  const list = store.state.chapters[idx];
  return Array.isArray(list) ? list.length : 0;
}

/** 第 0 章永远开放；其余要求前一章的**每一局**都留下纪录。 */
export function chapterUnlocked(store, idx) {
  if (idx <= 0) return true;
  const prev = CHAPTERS[idx - 1];
  if (!prev) return false;
  return chapterDone(store, idx - 1) >= prev.size;
}

export function nextPuzzle(store) {
  for (let i = 0; i < CHAPTERS.length; i++) {
    if (!chapterUnlocked(store, i)) continue;
    const done = new Set(store.state.chapters[i] || []);
    const list = puzzlesOfChapter(i);
    const found = list.find((p) => !done.has(p.id)) || list[0];
    if (found) return found;
  }
  return PUZZLES[0];
}

/**
 * 日课：种子只由日期决定，同一天全世界同一张盘。用 tier 2（7×7，实测现场生成 ~20ms）。
 * 三档以上是 live:false —— 那两档的题在构建期烘好，日课不碰它们。
 */
export const DAILY_TIER = 2;

export function dailyFor(at = new Date()) {
  const { key, epochDays } = dateSeed(at);
  const made = makePuzzle({ tier: DAILY_TIER, seed: 1000 + (epochDays % 99991) });
  return {
    ...made,
    kind: 'daily',
    day: key,
    id: `daily:${key}`,
    tier: DAILY_TIER,
    tierName: TIERS[DAILY_TIER].name,
    chapter: null,
    index: null,
    regionNeeded: !!made.meta.needsRegion,
    score: made.meta.score,
  };
}

/** 现抽一局。live:false 的档位从烘焙好的池子里轮着取（现场生成要几十秒）。 */
export function randomPuzzle(tier = 2, store = null) {
  const T = TIERS[Math.max(0, Math.min(TIERS.length - 1, tier | 0))];
  if (!T.live) {
    const list = PUZZLES.filter((p) => p.tier === T.idx);
    if (!list.length) throw new Error(`档位「${T.name}」没有烘焙好的题目`);
    let at = 0;
    if (store) {
      const done = store.state.chapters[T.idx] || [];
      at = done.length % list.length;
    } else {
      at = Math.floor(Date.now() / 1000) % list.length;
    }
    const p = list[at];
    // 顶层字段和 live 分支对齐（tier / chapter / index / score / regionNeeded）：
    // 烘焙题没有"本章第几局"以外的进度含义，但 UI 读的是同一组键，不该各自兜底。
    return {
      code: p.code,
      board: decodePuzzle(p.code),
      solution: null,
      meta: { ...p, tier: p.tier },
      kind: 'pool',
      id: p.id,
      tier: p.tier,
      tierName: T.name,
      chapter: p.chapter,
      index: p.index,
      regionNeeded: !!p.regionNeeded,
      score: p.score,
    };
  }
  const made = makePuzzle({ tier: T.idx, seed: (Math.floor(Math.random() * 1e9) | 0) + 1 });
  return {
    ...made,
    kind: 'random',
    id: puzzleId(made.code),
    tier: T.idx,
    tierName: T.name,
    chapter: null,
    index: null,
    regionNeeded: !!made.meta.needsRegion,
    score: made.meta.score,
  };
}

export function bestOf(store, id) {
  return store.state.best[id] || null;
}

export function summary(store, todayKey) {
  let done = 0;
  for (const c of CHAPTERS) done += Math.min(chapterDone(store, c.idx), c.size);
  const dailyDone = Object.values(store.state.daily).filter((d) => d.done).length;
  return {
    chapters: CHAPTERS.length,
    puzzles: PUZZLES.length,
    done,
    dailyDone,
    streak: store.streak(todayKey),
    unlocked: CHAPTERS.filter((c) => chapterUnlocked(store, c.idx)).length,
    baked: BAKE,
  };
}

export { TIERS, decodePuzzle, LEVELS, BAKE };
