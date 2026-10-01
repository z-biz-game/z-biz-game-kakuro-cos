'use strict';
// Service Worker 注册。三件事按顺序判，任何一件不成立就安静地什么都不做：
//   ① 浏览器没有 navigator.serviceWorker（旧 Safari、无痕窗口）；
//   ② 页面不是 http(s) 打开的 —— file:// 下 SW 注册必然抛，而 Electron 打包正是 file://
//      （electron/main.cjs 直接 loadFile），那条红字不是玩家的错，不该冒到控制台；
//   ③ 注册本身失败（Pages 前缀下的 scope 不匹配等）：catch 掉，离线壳是增强不是依赖。
(function registerServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  var boot = function () {
    // 相对路径：Pages 把本站放在 /<repo>/ 前缀下，写死 '/' 会注册到域名根去。
    navigator.serviceWorker.register('sw.js').catch(function () {});
  };
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
})();
