// Deterministic randomness. One FNV-1a hash into one xorshift stream: a save file stores the
// seed rather than the board, so "same seed, same board" is a storage requirement, not a nicety.
//
// The stream is deliberately *not* seeded from wall-clock time anywhere in the app: the daily
// puzzle is keyed by date, the campaign by a literal seed string, and a random board by a seed the
// UI just made up and immediately wrote to storage. If any of those paths let a slow solve change
// which board got picked, "续局重绘出同一块盘" would go red on a loaded machine.

export function mix(seed) {
  let x = typeof seed === 'string' ? 2166136261 : seed >>> 0;
  if (typeof seed === 'string') {
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619) >>> 0;
    }
  }
  x = x || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

export function randInt(rand, n) {
  return Math.floor(rand() * n);
}

export function shuffle(rand, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Date-keyed seed: local noon, so a board does not flip halfway through a solve just because the
// player started at 23:59:50.
export function dateSeed(at = new Date()) {
  const d = new Date(at.getTime());
  d.setHours(12, 0, 0, 0);
  return {
    key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    epochDays: Math.floor(d.getTime() / 86400000),
  };
}
