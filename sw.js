'use strict';
// 离线壳。**网络优先**：同源 GET 先打网络，命中就回填缓存；只有断网/5xx 才回落缓存。
// 为什么不用 cache-first：js/css 会被永久钉死在第一次抓到的版本上，发一版新 HTML 配旧
// JS 就是鬼状态（本仓的模块是 js/main.js 一路 import 下去的，钉住任何一环都会裂）。
//
// 路径一律相对 self.location 解析：Pages 把本站放在 /z-biz-game-kakuro-cos/ 前缀下，
// 写死 '/' 会让前缀形态离线全灭。
//
// VERSION 跟着 package.json 的 version 走；改了它，activate 会把旧缓存整个换掉。

const VERSION = 'v1.0.0';
const CACHE = `kakuro-${VERSION}`;
const CORE = [
  '.',
  'index.html',
  'manifest.webmanifest',
  'css/game.css',
  'js/main.js',
  'js/library.js',
  'js/store.js',
  'js/theme.js',
  'js/audio/synth.js',
  'js/data/levels.js',
  'js/engine/kakuro.js',
  'js/engine/combos.js',
  'js/engine/count.js',
  'js/engine/generate.js',
  'js/engine/rng.js',
  'js/render/board.js',
  'js/ui/game.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/favicon-32.png',
  'assets/icons/apple-touch-icon.png',
  'assets/textures/paper-256.png',
];

const at = (p) => new URL(p, self.location).href;

self.addEventListener('install', () => {
  self.skipWaiting();
  caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((p) => c.add(at(p))))).catch(() => {});
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          // 导航请求离线时回落到缓存里的那份壳，别给玩家一个白屏
          return req.mode === 'navigate' ? caches.match(at('index.html')) : Response.error();
        })
      )
  );
});
