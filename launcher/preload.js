/* 单机版 —— preload：把「本地服务」暴露给页面（主世界可用） */
const { ipcRenderer } = require('electron');

window.__LOCAL_API__ = function (route, payload) {
  return ipcRenderer.invoke('solo-api', Object.assign({ route: route }, payload || {}));
};

console.log('[solo] preload ready');
