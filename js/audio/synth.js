// 全部音效都由 WebAudio 现场合成，一个音频文件都没有（规范 §2：无美术/音频资源）。
//
// 每个声音都是"两个振荡器 + 一条包络"，短、轻、不糊在一起。AudioContext 只有在用户
// 真的点过一下之后才创建 —— 浏览器不允许更早，早创建会被挂起，第一局就哑了。

const NOTES = {
  tap: { f: 523.25, f2: 784, dur: 0.07, type: 'triangle', gain: 0.1 },
  erase: { f: 233.08, f2: 174.61, dur: 0.09, type: 'sine', gain: 0.09 },
  note: { f: 659.25, f2: 659.25, dur: 0.045, type: 'square', gain: 0.035 },
  reject: { f: 155.56, f2: 116.54, dur: 0.16, type: 'sawtooth', gain: 0.075 },
  hint: { f: 880, f2: 1174.66, dur: 0.12, type: 'triangle', gain: 0.09 },
  undo: { f: 349.23, f2: 293.66, dur: 0.08, type: 'sine', gain: 0.07 },
  win: { f: 523.25, f2: 1046.5, dur: 0.5, type: 'triangle', gain: 0.12 },
  chapter: { f: 392, f2: 659.25, dur: 0.32, type: 'triangle', gain: 0.1 },
};

let ctx = null;
let master = null;
let muted = false;

function ensure() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

export function unlockAudio() {
  ensure();
}

export function setMuted(next) {
  muted = !!next;
  if (master) master.gain.value = muted ? 0 : 0.9;
  return muted;
}

export function isMuted() {
  return muted;
}

/** 一次两音滑音。kind 决定波形/时长/音量，见上面的 NOTES 表。 */
export function play(kind = 'tap', { detune = 0, when = 0 } = {}) {
  const ac = ensure();
  if (!ac || muted) return;
  const spec = NOTES[kind] || NOTES.tap;
  const t0 = ac.currentTime + when;
  const osc = ac.createOscillator();
  const osc2 = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = spec.type;
  osc2.type = spec.type;
  osc.frequency.setValueAtTime(spec.f * Math.pow(2, detune / 1200), t0);
  osc2.frequency.setValueAtTime(spec.f2 * Math.pow(2, detune / 1200), t0);
  if (kind === 'win' || kind === 'chapter') {
    osc.frequency.exponentialRampToValueAtTime(spec.f2, t0 + spec.dur * 0.6);
    osc2.frequency.exponentialRampToValueAtTime(spec.f2 * 1.5, t0 + spec.dur * 0.6);
  }
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(spec.gain, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + spec.dur);
  osc.connect(gain);
  osc2.connect(gain);
  gain.connect(master);
  osc.start(t0);
  osc2.start(t0 + 0.005);
  osc.stop(t0 + spec.dur + 0.02);
  osc2.stop(t0 + spec.dur + 0.02);
}

export function arpeggio(count = 4, step = 0.07) {
  for (let i = 0; i < count; i++) play('tap', { detune: i * 400 / 12, when: i * step });
}
