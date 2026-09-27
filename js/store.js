// 存档。一个键、一份形状、脏数据进得来、坏数据出不去。
//
// 三条硬规矩（规范 §2 末段）：
//   ① 只用一个 localStorage 键：kakuro.save.v1。别的什么都不写。
//   ② 读进来先清洗：每个字段都过 sanitize\*，缺的补默认、类型错的丢掉、越界的夹紧。
//      localStorage 也可能整个儿抛异常（隐私模式、配额），所以连 getter 都包起来。
//   ③ 代价跟着盘走：步数/提示数/用时是**这一局**的账，换局就清零；同局恢复必须原样回来，
//      不然刷新就变成免费重开。reset() 同时清内存与磁盘。
//
// 墨水用 RLE（大盘连续同值多），笔记用"每格 2 字节小端 + RLE"，两者都过同一个编解码器。

export const KEY = 'kakuro.save.v1';
export const VERSION = 1;

// ---- 编解码 ----------------------------------------------------------------------------------

/** 数字数组 → RLE 字符串：值*1000+游程，再 36 进制。空数组 ⇒ 空串。 */
export function rleEncode(arr) {
  if (!arr || !arr.length) return '';
  const out = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i] | 0;
    let run = 1;
    while (i + run < arr.length && (arr[i + run] | 0) === v) run++;
    out.push((v * 1000 + Math.min(run, 999)).toString(36));
    if (run > 999) {
      let left = run - 999;
      while (left > 0) {
        const chunk = Math.min(left, 999);
        out.push((v * 1000 + chunk).toString(36));
        left -= chunk;
      }
    }
    i += run;
  }
  return out.join('.');
}

export function rleDecode(text, len) {
  const out = new Uint8Array(len);
  if (!text || typeof text !== 'string') return out;
  let at = 0;
  for (const part of text.split('.')) {
    const n = parseInt(part, 36);
    if (!Number.isFinite(n) || n < 0) continue;
    const v = Math.floor(n / 1000);
    const run = n % 1000;
    if (v > 255 || run < 1) continue;
    for (let k = 0; k < run && at < len; k++) out[at++] = v;
  }
  return out;
}

/** 笔记：每格一个 16 位掩码，拆成高低两个字节后走同一个 RLE。 */
export function encodeNotes(mask) {
  const bytes = new Uint8Array(mask.length * 2);
  for (let i = 0; i < mask.length; i++) {
    bytes[i * 2] = mask[i] & 255;
    bytes[i * 2 + 1] = (mask[i] >> 8) & 255;
  }
  return rleEncode(bytes);
}

export function decodeNotes(text, len) {
  const bytes = rleDecode(text, len * 2);
  const out = new Uint16Array(len);
  for (let i = 0; i < len; i++) out[i] = (bytes[i * 2] | 0) | ((bytes[i * 2 + 1] | 0) << 8);
  return out;
}

// ---- 清洗 ------------------------------------------------------------------------------------

const isInt = (v) => typeof v === 'number' && Number.isFinite(v) && Math.round(v) === v;
const clampInt = (v, lo, hi, dflt) => (isInt(v) ? Math.max(lo, Math.min(hi, v)) : dflt);
const str = (v, max = 64) => (typeof v === 'string' && v.length <= max ? v : '');

export function sanitizeCode(code) {
  if (!code || typeof code !== 'object') return null;
  const w = clampInt(code.w, 3, 16, 0);
  const h = clampInt(code.h, 3, 16, 0);
  if (!w || !h) return null;
  const ok = (s) => typeof s === 'string' && s.length === w * h;
  if (!ok(code.bl) || !ok(code.ac) || !ok(code.dn)) return null;
  return { w, h, bl: code.bl, ac: code.ac, dn: code.dn };
}

export function sanitizeResume(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const code = sanitizeCode(raw.code);
  if (!code) return null;
  const cells = countWhite(code);
  if (!cells) return null;
  const values = clampArr(rleDecode(raw.ink, cells), cells, 0, 9);
  const notes = clampArr(decodeNotes(raw.notes, cells), cells, 0, 1023);
  return {
    code,
    values,
    notes,
    moves: clampInt(raw.moves, 0, 1e6, 0),
    hints: clampInt(raw.hints, 0, 1e5, 0),
    ms: clampInt(raw.ms, 0, 1e10, 0),
    status: raw.status === 'won' ? 'won' : 'playing',
    kind: str(raw.kind) || 'random',
    day: str(raw.day, 12),
    tier: clampInt(raw.tier, 0, 8, 0),
    chapter: clampInt(raw.chapter, -1, 40, -1),
    index: clampInt(raw.index, -1, 400, -1),
  };
}

function countWhite(code) {
  let n = 0;
  for (const ch of code.bl) if (ch === '0') n++;
  return n;
}

function clampArr(arr, len, lo, hi) {
  const out = new Uint16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.max(lo, Math.min(hi, arr[i] | 0));
  return out;
}

export function sanitizeBest(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw)) {
    if (typeof id !== 'string' || id.length > 160 || !v || typeof v !== 'object') continue;
    const e = {
      moves: clampInt(v.moves, 0, 1e6, 0),
      hints: clampInt(v.hints, 0, 1e5, 0),
      ms: clampInt(v.ms, 0, 1e10, 0),
      date: str(v.date, 12),
    };
    if (e.ms || e.moves) out[id] = e;
  }
  return out;
}

/** 同一个人做的同一局，先比提示、再比步数、最后比用时（提示是外力，权重最高）。 */
export function betterThan(a, b) {
  if (!b) return true;
  if (a.hints !== b.hints) return a.hints < b.hints;
  if (a.moves !== b.moves) return a.moves < b.moves;
  return a.ms < b.ms;
}

export function sanitizeRuns(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [day, v] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v || typeof v !== 'object') continue;
    out[day] = {
      done: !!v.done,
      tier: clampInt(v.tier, 0, 8, 0),
      moves: clampInt(v.moves, 0, 1e6, 0),
      hints: clampInt(v.hints, 0, 1e5, 0),
      ms: clampInt(v.ms, 0, 1e10, 0),
      id: str(v.id, 160),
    };
  }
  return out;
}

export function sanitizeChapters(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx > 60) continue;
    if (!Array.isArray(v)) continue;
    out[idx] = v.filter((x) => typeof x === 'string' && x.length <= 160).slice(0, 200);
  }
  return out;
}

export function sanitize(raw) {
  const s = { version: VERSION, resume: null, best: {}, daily: {}, chapters: {}, options: {} };
  if (!raw || typeof raw !== 'object') return s;
  s.resume = sanitizeResume(raw.resume);
  s.best = sanitizeBest(raw.best);
  s.daily = sanitizeRuns(raw.daily);
  s.chapters = sanitizeChapters(raw.chapters);
  const o = raw.options && typeof raw.options === 'object' ? raw.options : {};
  s.options = {
    muted: !!o.muted,
    tier: clampInt(o.tier, 0, 8, 2),
    hideNotes: !!o.hideNotes,
  };
  return s;
}

// ---- 存储 ------------------------------------------------------------------------------------

function storage() {
  try {
    const s = globalThis.localStorage;
    if (!s || typeof s.getItem !== 'function') return null;
    return s;
  } catch {
    return null; // 隐私模式下连属性访问都会抛
  }
}

/** 盘上只允许一种形状：墨水以 ink 字符串存放（内存里的展开态不算）。
 *  开机 load 之后 state.resume 是 sanitizeResume 展开的 values/notes 数组，原样 stringify
 *  会写成 "values":{"0":1,…} 这种没有 ink 字段的对象，下次启动 sanitizeResume 读不到
 *  棋盘，整盘被当成空——刷新两次 = 丢档。所以回写前必须重编码成 ink 形状。 */
function toDiskShape(resume) {
  if (!resume || typeof resume.ink === 'string') return resume;
  if (!resume.values || typeof resume.values.length !== 'number') return resume;
  const { values, notes, ...rest } = resume;
  return {
    ...rest,
    ink: rleEncode(values),
    notes: typeof notes === 'string' ? notes : encodeNotes(notes || []),
  };
}

export function createStore(backend = storage()) {
  let state = sanitize(null);
  const api = {
    get state() {
      return state;
    },
    load() {
      if (!backend) return state;
      let parsed = null;
      try {
        const text = backend.getItem(KEY);
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      state = sanitize(parsed);
      return state;
    },
    save() {
      if (!backend) return false;
      try {
        backend.setItem(KEY, JSON.stringify({ ...state, resume: toDiskShape(state.resume) }));
        return true;
      } catch {
        return false; // 配额满/被禁用：内存里继续玩，不炸
      }
    },
    reset() {
      state = sanitize(null);
      api.save();
      return state;
    },
    setResume(resume) {
      state.resume = resume || null;
      api.save();
    },
    recordFinish(id, entry) {
      const e = {
        moves: clampInt(entry.moves, 0, 1e6, 0),
        hints: clampInt(entry.hints, 0, 1e5, 0),
        ms: clampInt(entry.ms, 0, 1e10, 0),
        date: str(entry.date, 12),
      };
      if (betterThan(e, state.best[id])) state.best[id] = e;
      api.save();
      return state.best[id];
    },
    recordDaily(day, entry) {
      state.daily[day] = {
        done: true,
        tier: clampInt(entry.tier, 0, 8, 0),
        moves: clampInt(entry.moves, 0, 1e6, 0),
        hints: clampInt(entry.hints, 0, 1e5, 0),
        ms: clampInt(entry.ms, 0, 1e10, 0),
        id: str(entry.id, 160),
      };
      api.save();
      return state.daily[day];
    },
    markChapter(chapterIdx, id) {
      const list = state.chapters[chapterIdx] || (state.chapters[chapterIdx] = []);
      if (!list.includes(id)) list.push(id);
      api.save();
      return list;
    },
    setOptions(patch) {
      state.options = { ...state.options, ...patch };
      api.save();
      return state.options;
    },
    /** 连续日课天数：从今天（或昨天）往前数。 */
    streak(todayKey) {
      const days = Object.keys(state.daily).filter((k) => state.daily[k].done).sort();
      if (!days.length) return 0;
      const add = (key, n) => {
        const [y, m, d] = key.split('-').map(Number);
        const dt = new Date(y, m - 1, d + n);
        return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      };
      let cur = state.daily[todayKey] ? todayKey : add(todayKey, -1);
      if (!state.daily[cur]) return 0;
      let n = 0;
      while (state.daily[cur]) {
        n++;
        cur = add(cur, -1);
      }
      return n;
    },
    exportText() {
      return JSON.stringify(state);
    },
  };
  return api;
}

export const defaultStore = () => createStore(storage());
