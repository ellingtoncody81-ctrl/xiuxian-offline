/* 单机版 PoC —— Electron 主进程
 * 职责：
 *  1) 内置静态服务托管 www/（Cocos build，无外部进程）
 *  2) 页面就绪后注入 inject.js（本地接口层：拦截发往游戏服的 XHR）
 *  3) --autotest：自动点击登录 → 截图 → 观察是否进主城
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const LocalServer = require('./local-server');

const ROOT = __dirname;
const WWW = path.join(ROOT, '..', 'www');
const FIXTURES_DIR = path.join(ROOT, 'fixtures');
const SHOTS_DIR = path.join(ROOT, 'shots');
const CONSOLE_LOG = path.join(ROOT, '..', 'renderer_console.log');
const AUTOTEST = process.argv.includes('--autotest');
const SMOKE_PICKER = process.argv.includes('--smoke-picker');
const SMOKE_ACCOUNTS = process.argv.includes('--smoke-accounts');   // 只开账号窗口自检渲染，不动数据
const CAPTURE_STARTUP = process.argv.includes('--capture-startup'); // 启动连拍：每 400ms 拍一张，看启动画面残留
const KEEP_BOOT = process.argv.includes('--keep-boot');             // 保留闪屏/登录页（默认隐藏，直进游戏）
const UICHECK = (function () { const a = process.argv.find(v => v.startsWith('--uicheck=')); return a ? a.split('=').slice(1).join('=') : ''; })();
const SHOW_ACCOUNTS = process.argv.includes('--accounts');   // 手动打开「登录账号」窗口（换号/删号用）
const ARG_ACCOUNT = (function () { const a = process.argv.find(v => v.startsWith('--account=')); return a ? a.split('=').slice(1).join('=') : ''; })();
// 维护命令（不启动游戏）：--list-accounts 列账号 / --del-account=名字 删账号
const ARG_LIST_ACCOUNTS = process.argv.includes('--list-accounts');
const ARG_DEL_ACCOUNT = (function () { const a = process.argv.find(v => v.startsWith('--del-account=')); return a ? a.split('=').slice(1).join('=') : ''; })();
// 固定端口：客户端 localStorage（账号/设置/引导状态）按 origin 隔离，
// 随机端口会导致每次启动都变成"全新存档感"——必须固定。
const STATIC_PORT = 57130;
// [solo v4.46] 日志清空挪进 main()：否则多开时第二实例会把第一个实例正在写的日志清掉

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.fnt': 'text/plain',
  '.plist': 'text/xml', '.xml': 'text/xml', '.txt': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream', '.bin': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8', '.meta': 'application/json; charset=utf-8'
};

function buildFixtures() {
  const out = {};
  for (const f of fs.readdirSync(FIXTURES_DIR)) {
    if (!f.endsWith('.json') || f.includes('_alt_')) continue;
    const route = f.replace(/\.json$/, '').replace('_', '/');
    out[route] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'));
  }
  return out;
}

function buildInject(account) {
  const tpl = fs.readFileSync(path.join(ROOT, 'inject.js'), 'utf8');
  const finalSrc = tpl.replace('__FIXTURES_JSON__', JSON.stringify(buildFixtures()))
                     .replace('__SOLO_ACCOUNT__', JSON.stringify(String(account || '')))
                     .replace('__KEEP_BOOT__', KEEP_BOOT ? 'true' : 'false');
  return finalSrc + '\n"__solo_injected__";';
}

function startStatic() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const fp = path.normalize(path.join(WWW, p));
      if (!fp.startsWith(WWW)) { res.writeHead(403); return res.end('403'); }
      fs.readFile(fp, (err, data) => {
        if (err) { console.log('[http] 404 ' + p); res.writeHead(404); return res.end('404 ' + p); }
        if (p.indexOf('/assets/') !== 0) console.log('[http] ' + p);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      });
    });
    let port = STATIC_PORT;
    const onErr = (e) => {
      if (e && e.code === 'EADDRINUSE' && port < STATIC_PORT + 9) { port += 1; srv.listen(port, '127.0.0.1'); }
      else { reject(e); }
    };
    srv.on('error', onErr);
    srv.listen(port, '127.0.0.1', () => {
      console.log('[solo] 静态端口=' + port + (port !== STATIC_PORT ? '(默认被占用已顺延)' : ''));
      resolve(srv);
    });
  });
}

const CLICK_PROBE = `(function () {
  try {
    if (!window.cc || !cc.director) return 'no-cc';
    var scene = cc.director.getScene();
    if (!scene) return 'no-scene';
    var cls = cc.js.getClassByName('UILocalLogin');
    if (!cls) return 'no-cls';
    var found = null;
    (function dfs(n) {
      if (found || !n) return;
      if (n.getComponent && n.getComponent(cls)) { found = n.getComponent(cls); return; }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    if (!found) return 'no-ui';
    if (window.__SOLO_CLICKED__) return 'clicked';
    window.__SOLO_CLICKED__ = true;
    found.onClickLogin();
    console.log('[solo] onClickLogin() invoked');
    return 'clicked';
  } catch (e) { return 'ERR:' + e.message; }
})()`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let win = null;
let pickerWin = null;   // [solo v4.46] 选号窗引用：finish() 先 hide，等游戏窗建好再 close
let BOOTING = true;     // [solo v4.46] 启动期守卫：boot 未完成前忽略 window-all-closed
let homeSeen = false;

/* ------- 底部菜单「巡一圈」（真实鼠标点击，验证每个菜单都能进） ------- */
const TOUR = ['秘境', '仙盟', '历练', '角色', '斗法', '洞天', '钓鱼'];

const DUMP_BOTTOM = `(function(){
  try {
    var scene = cc.director.getScene(); var out = [];
    (function dfs(n){
      if (!n) return;
      if (n.activeInHierarchy) {
        var L = n.getComponent && n.getComponent(cc.Label);
        if (L && L.string) {
          var wp = n.convertToWorldSpaceAR(cc.v2(0, 0));
          if (wp.y < 400) out.push(String(L.string).slice(0, 10) + '@' + Math.round(wp.x) + ',' + Math.round(wp.y));
        }
      }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    return out.slice(0, 80);
  } catch (e) { return 'ERR:' + e.message; }
})()`;

function findClickScript(name) {
  return `(function(){
  var target = ${JSON.stringify(name)};
  try {
    var scene = cc.director.getScene(); if (!scene) return 'no-scene';
    var hit = null;
    (function dfs(n){
      if (hit || !n) return;
      if (!n.activeInHierarchy) return;
      var L = n.getComponent && n.getComponent(cc.Label);
      if (L && L.string && String(L.string).replace(/\\s/g, '') === target) { hit = n; return; }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    if (!hit) return 'notfound';
    var node = hit;
    for (var k = 0; k < 7 && node.parent; k++) {
      if (node.getComponent && node.getComponent(cc.Button)) break;
      node = node.parent;
    }
    var wp = node.convertToWorldSpaceAR(cc.v2(0, 0));
    var v = cc.view.getViewportRect();
    var dpr = window.devicePixelRatio || 1;
    var px = v.x + wp.x * (v.width / 750);
    var py = v.y + (1334 - wp.y) * (v.height / 1334);
    return { x: Math.round(px / dpr), y: Math.round(py / dpr), node: node.name, lab: hit.name };
  } catch (e) { return 'ERR:' + e.message; }
})()`;
}

/* ------- 巡游辅助 ------- */
const DUMP_BUTTONS = `(function(){
  try {
    var scene = cc.director.getScene(); var out = [];
    (function dfs(n){
      if (!n) return;
      if (n.getComponent && n.getComponent(cc.Button)) {
        var wp = n.convertToWorldSpaceAR(cc.v2(0, 0));
        out.push(n.name + '@' + Math.round(wp.x) + ',' + Math.round(wp.y) + (n.activeInHierarchy ? '' : '(off)'));
      }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    return out.slice(0, 120);
  } catch (e) { return 'ERR:' + e.message; }
})()`;

const DUMP_MENU_LABELS = `(function(){
  try {
    var targets = ['秘境','仙盟','历练','角色','斗法','洞天','钓鱼'];
    var scene = cc.director.getScene(); var out = [];
    (function dfs(n){
      if (!n) return;
      var L = n.getComponent && n.getComponent(cc.Label);
      if (L && L.string) {
        var s = String(L.string).replace(/\s/g, '');
        for (var t = 0; t < targets.length; t++) {
          if (s === targets[t]) {
            var wp = n.convertToWorldSpaceAR(cc.v2(0, 0));
            out.push(s + '@' + Math.round(wp.x) + ',' + Math.round(wp.y) + ' act=' + (n.activeInHierarchy ? 1 : 0));
          }
        }
      }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    return out.slice(0, 40);
  } catch (e) { return 'ERR:' + e.message; }
})()`;

const CLICK_CLOSE = `(function(){
  try {
    var re = /^(btnClose|btnGuanbi|imgClose|btnX|btnExit|btnOk|btnKnow)$/;
    var scene = cc.director.getScene(); var hit = null;
    (function dfs(n){
      if (hit || !n) return;
      if (n.activeInHierarchy && re.test(n.name)) { hit = n; return; }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    if (!hit) return 'notfound';
    var wp = hit.convertToWorldSpaceAR(cc.v2(0, 0));
    var v = cc.view.getViewportRect(); var dpr = window.devicePixelRatio || 1;
    var px = v.x + wp.x * (v.width / 750); var py = v.y + (1334 - wp.y) * (v.height / 1334);
    return { x: Math.round(px / dpr), y: Math.round(py / dpr), node: hit.name };
  } catch (e) { return 'ERR:' + e.message; }
})()`;

function jsClickByLabel(name) {
  return `(function(){
  var target = ${JSON.stringify(name)};
  try {
    var scene = cc.director.getScene(); var hit = null;
    (function dfs(n){
      if (hit || !n) return;
      if (!n.activeInHierarchy) return;
      var L = n.getComponent && n.getComponent(cc.Label);
      if (L && L.string && String(L.string).replace(/\s/g, '') === target) { hit = n; return; }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    if (!hit) return 'notfound';
    var node = hit;
    for (var k = 0; k < 7 && node.parent; k++) {
      if (node.getComponent && (node.getComponent(cc.Button) || node.getComponent(cc.Toggle))) break;
      node = node.parent;
    }
    var wp = node.convertToWorldSpaceAR(cc.v2(0, 0));
    var v = cc.view.getViewportRect(); var dpr = window.devicePixelRatio || 1;
    var px = v.x + wp.x * (v.width / 750); var py = v.y + (1334 - wp.y) * (v.height / 1334);
    return { x: Math.round(px / dpr), y: Math.round(py / dpr), node: node.name };
  } catch (e) { return 'ERR:' + e.message; }
})()`;
}

async function clickAt(js, tag) {
  let r;
  try { r = await win.webContents.executeJavaScript(js); }
  catch (e) { r = 'EXEC:' + e.message; }
  if (r && typeof r === 'object' && r.x !== undefined) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    await sleep(50);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(50);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    console.log('[solo] ' + tag + ' -> click(' + r.x + ',' + r.y + ') node=' + r.node);
  } else {
    console.log('[solo] ' + tag + ' => ' + JSON.stringify(r));
  }
  return r;
}

/* ------- 按按钮名点击（菜单文字是美术图，按名字最稳） ------- */
const DUMP_BOTTOM_BTNS = `(function(){
  try {
    var scene = cc.director.getScene(); var out = [];
    (function dfs(n){
      if (!n) return;
      if (n.getComponent && n.getComponent(cc.Button)) {
        var wp = n.convertToWorldSpaceAR(cc.v2(0, 0));
        if (wp.y < 120) out.push(n.name + '@' + Math.round(wp.x) + ',' + Math.round(wp.y) + (n.activeInHierarchy ? '' : '(off)'));
      }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    return out;
  } catch (e) { return 'ERR:' + e.message; }
})()`;

function jsClickByName(name) {
  return `(function(){
  var target = ${JSON.stringify(name)};
  try {
    var scene = cc.director.getScene();
    var hit = null, offHit = null;
    (function dfs(n){
      if (!n || (hit && offHit)) return;
      if (n.name === target) {
        if (n.activeInHierarchy && !hit) hit = n;
        if (!n.activeInHierarchy && !offHit) offHit = n;
      }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) dfs(ch[i]);
    })(scene);
    if (!hit) return offHit ? 'inactive' : 'notfound';
    var bb = hit.getBoundingBoxToWorld();
    var wx = bb.x + bb.width / 2, wy = bb.y + bb.height / 2;
    var v = cc.view.getViewportRect(); var dpr = window.devicePixelRatio || 1;
    var px = v.x + wx * (v.width / 750); var py = v.y + (1334 - wy) * (v.height / 1334);
    return { x: Math.round(px / dpr), y: Math.round(py / dpr), node: hit.name };
  } catch (e) { return 'ERR:' + e.message; }
})()`;
}

async function tourOnce() {
  console.log('[solo] tour begin');
  try { console.log('[solo] bottom-btns: ' + JSON.stringify(await win.webContents.executeJavaScript(DUMP_BOTTOM_BTNS))); } catch (e) { }
  // 收公告弹窗
  await clickAt(jsClickByLabel('今日不再提示'), 'click-nodismiss');
  await sleep(400);
  await clickAt(CLICK_CLOSE, 'click-close');
  await sleep(1500);
  // 开箱测试：点鼎炉（imgBox），验证 equip/openBox95
  {
    let r = await clickAt(jsClickByName('imgBox'), 'box-open-click');
    if (!r || typeof r !== 'object' || r.x === undefined) {
      const x = Math.round(375 * (540 / 750));
      const y = Math.round(995 * (960 / 1334));
      win.webContents.sendInputEvent({ type: 'mouseMove', x: x, y: y });
      await sleep(50);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: x, y: y, button: 'left', clickCount: 1 });
      await sleep(50);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: x, y: y, button: 'left', clickCount: 1 });
      console.log('[solo] box-open-click fallback -> (' + x + ',' + y + ')');
    }
    await sleep(3800);
    try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS_DIR, 'box_open.png'), img.toPNG()); } catch (e) { }
  }
  // 逐个点底部菜单（按真实按钮名）
  const btns = ['btnWanfa', 'btnClub', 'btnPve', 'btnHome', 'btnPvp', 'btnMine', 'btnFushi'];
  for (let i = 0; i < btns.length; i++) {
    const r = await clickAt(jsClickByName(btns[i]), 'tour ' + btns[i]);
    if (r && typeof r === 'object' && r.x !== undefined) {
      await sleep(2400);
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SHOTS_DIR, 'tour_' + i + '_' + btns[i] + '.png'), img.toPNG());
      } catch (e) { }
    }
  }
  console.log('[solo] tour end');
}

/* ------- 自动点「进入游戏」（选服界面）：单机只有一区，省掉这一步手动点击 -------
/* 真实鼠标事件路径（与下方菜单点击同源，已验证可靠），正常玩/自动测试都生效 */
/* ------- 自动点游戏内「登录」按钮（跳过登录页；页面自带防重复 guard） ------- */
async function watchLogin() {
  for (let i = 0; i < 400; i++) {
    await sleep(1500);
    if (!win || win.isDestroyed()) return;
    let r;
    try { r = await win.webContents.executeJavaScript(CLICK_PROBE); } catch (e) { continue; }
    if (r === 'clicked') { console.log('[solo] auto-login 已点击「登录」'); return; }
  }
}

async function watchEnterGame() {
  // 找「进入游戏」按钮：优先按节点名 btnEnter（该按钮文字是美术图，按文字找不到），文字法兜底
  const probeEnterBtn = async () => {
    let r = null;
    try { r = await win.webContents.executeJavaScript(jsClickByName('btnEnter')); } catch (e) { }
    if (r && typeof r === 'object' && r.x !== undefined) return r;
    try { r = await win.webContents.executeJavaScript(jsClickByLabel('进入游戏')); } catch (e) { }
    return (r && typeof r === 'object' && r.x !== undefined) ? r : null;
  };
  let done = false;
  for (let i = 0; i < 450 && !done; i++) {   // 扫描窗口 ~15 分钟（每 2s 一次）
    await sleep(2000);
    if (!win || win.isDestroyed()) return;
    const r = await probeEnterBtn();
    if (r) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
      await sleep(60);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(60);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      console.log('[solo] auto-enter 已点「进入游戏」(' + r.x + ',' + r.y + ') node=' + r.node);
      await sleep(5000);
      const still = await probeEnterBtn();
      if (still) {
        console.log('[solo] auto-enter 按钮仍在，重试…');
        continue;
      }
      done = true;
      console.log('[solo] auto-enter 完成（已离开选服界面）');
    }
  }
}

// 自动开界面核对（--uicheck=club|shop2|dump|idleN|battle）：进主城 → 点入口 → 查节点真状态 → 截图
async function uiCheck(kind) {
  console.log('[solo] uicheck begin: ' + kind);
  for (let i = 0; i < 90 && !homeSeen; i++) await sleep(1000);
  await sleep(2500);
  const js = (code) => win.webContents.executeJavaScript(code);
  if ((await js('typeof window.__HK')) !== 'object') {
    await js(fs.readFileSync(path.join(WWW, 'probe_hk.js'), 'utf8'));
    console.log('[solo] 已注入 __HK');
  }
  const find = (n) => js('(function(){var r=__HK.find(' + JSON.stringify(n) + ');return r?JSON.stringify(r):null;})()');
  const click = async (n) => {
    const r = await find(n);
    if (!r) { console.log('[solo] 找不到节点 ' + n); return false; }
    const o = JSON.parse(r);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: o.x, y: o.y });
    await sleep(80);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: o.x, y: o.y, button: 'left', clickCount: 1 });
    await sleep(60);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: o.x, y: o.y, button: 'left', clickCount: 1 });
    console.log('[solo] 已点击 ' + n + ' @' + o.x + ',' + o.y);
    return true;
  };
  const state = (n) => js('(function(){function dfs(x,q){if(x.name===q)return x;var c=x.children||[];for(var i=0;i<c.length;i++){var r=dfs(c[i],q);if(r)return r;}return null;}var n=dfs(cc.director.getScene(),' + JSON.stringify(n) + ');return n?String(n.activeInHierarchy):"absent";})()');
  if (kind === 'club' || kind === 'clubfx') {
    await click('btnClub');
    await sleep(3000);
    console.log('[solo] btnClubFight 状态 = ' + (await state('btnClubFight')) + '（期望 false = 已隐藏）');
    // 仙盟主页：dump 全部可见文本（Label）→ 落盘 + 截图（含 gChatSimple 最近聊天）
    const dumpTexts = `(function(){try{var out=[];function dfs(n,p){var lb=null;try{lb=n.getComponent&&n.getComponent(cc.Label);}catch(e){}if(lb&&lb.string&&String(lb.string).trim()){out.push(p+' = '+String(lb.string).slice(0,60));}var c=n.children||[];for(var i=0;i<c.length;i++)dfs(c[i],p+'/'+c[i].name);}dfs(cc.director.getScene(),'');return JSON.stringify(out.slice(0,220));}catch(e){return 'ERR:'+e.message;}})()`;
    const t1 = await js(dumpTexts);
    try { fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_club_texts.txt'), String(t1), 'utf8'); } catch (e) { }
    console.log('[solo] club 文本: ' + String(t1).slice(0, 2500));
    try { const i0 = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_club.png'), i0.toPNG()); console.log('[solo] 截图 -> shots/uicheck_club.png'); } catch (e) { }
    if (kind === 'clubfx') {
      // 福星阁：先试真点击 btnClubFxgz，不行则直开 UIClubBlessView
      let ok = false;
      try { ok = await click('btnClubFxgz'); } catch (e) { }
      console.log('[solo] 点 btnClubFxgz = ' + ok);
      await sleep(3500);
      let seen = await js(`(function(){try{var n=__HK.find('clubBlessView');return n?'FOUND':'NO';}catch(e){return 'ERR:'+e.message;}})()`);
      if (!ok || seen !== 'FOUND') {
        const r2 = await js(`(function(){try{var cls=cc.js.getClassByName('UIClubBlessView');if(!cls)return 'NO_CLS';window.__UIMNG.openUI(cls,100);return 'OPENED';}catch(e){return 'ERR:'+e.message;}})()`);
        console.log('[solo] 直开 UIClubBlessView: ' + r2);
        await sleep(3500);
        seen = await js(`(function(){try{var n=__HK.find('clubBlessView');return n?'FOUND':'NO';}catch(e){return 'ERR:'+e.message;}})()`);
      }
      console.log('[solo] clubBlessView 出现 = ' + seen);
      const t2 = await js(dumpTexts);
      try { fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_clubfx_texts.txt'), String(t2), 'utf8'); } catch (e) { }
      console.log('[solo] clubfx 文本: ' + String(t2).slice(0, 4000));
      try { const i1 = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_clubfx.png'), i1.toPNG()); console.log('[solo] 截图 -> shots/uicheck_clubfx.png'); } catch (e) { }
    }
  } else if (kind === 'dump') {
    const list = await js('(function(){var out=[];function dfs(n,p){if(n.activeInHierarchy)out.push(p);var c=n.children||[];for(var i=0;i<c.length;i++)dfs(c[i],p+"/"+c[i].name);}dfs(cc.director.getScene(),"");return JSON.stringify(out.filter(function(s){return /(shop|diamond|gold|add|buy|pay|jintiao|store|mall|gou)/i.test(s);}).slice(0,150));})()');
    console.log('[solo] 候选节点: ' + list);
  } else if (kind === 'hdchou') {
    // 九龙榜专项自检：hook 网络请求 → 直开九龙界面 → 抓 rank/getList 的 hdcid → dump 节点 + 截图
    const rep = [];
    const logrep = (s) => { rep.push(s); console.log('[solo] ' + s); };
    for (const cn of ['btnClose', 'imgClose']) { for (let i = 0; i < 3; i++) { const ok = await click(cn); if (!ok) break; await sleep(500); } }
    // hook XHR，抓所有请求 URL
    logrep('XHR hook: ' + (await js(`(function(){ if (window.__XR) { window.__XR.length = 0; return 'reset'; } window.__XR = []; var oo = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(m, u) { try { window.__XR.push(m + ' ' + u); } catch (e) { } return oo.apply(this, arguments); }; return 'HOOKED'; })()`)));
    // 直开九龙界面
    logrep('openUI: ' + (await js(`(function(){ try { var cls = cc.js.getClassByName('UIHdChouView'); if (!cls) return 'NO_CLS'; window.__UIMNG.openUI(cls); return 'OPENED'; } catch (e) { return 'ERR:' + e.message; } })()`)));
    await sleep(4000);
    // 抓到的请求
    const reqs = await js(`(function(){ try { return JSON.stringify((window.__XR || []).filter(function(s){ return /rank|Rank|hd|Hd/.test(s); })); } catch (e) { return 'ERR:' + e.message; } })()`);
    logrep('请求: ' + String(reqs).slice(0, 1500));
    // dump 界面节点里榜相关的
    const dump = await js(`(function(){ try { var out = []; function dfs(n, p, d) { if (d > 13) return; if (n.activeInHierarchy) out.push(p); var c = n.children || []; for (var i = 0; i < c.length; i++) dfs(c[i], p + '/' + c[i].name, d + 1); } dfs(cc.director.getScene(), '', 0); var hits = out.filter(function(s){ return /(rank|Rank|phList|item|Item)/.test(s); }); return JSON.stringify({ total: out.length, hits: hits.slice(-100) }); } catch (e) { return 'ERR:' + e.message; } })()`);
    logrep('dump: ' + String(dump).slice(0, 3500));
    // 6) 找"排名信息/排行榜"类按钮并点击 → 抓 rank 请求 → dump 榜数据 → 截图
    const candRaw = await js(`(function(){ try { var out = []; function dfs(n, p, d) { if (d > 14) return; if (n.activeInHierarchy) { var nm = String(n.name); if (/pm|Pm|rank|Rank/.test(nm) || nm.indexOf('排名') >= 0) out.push(p); } var c = n.children || []; for (var i = 0; i < c.length; i++) dfs(c[i], p + '/' + c[i].name, d + 1); } dfs(cc.director.getScene(), '', 0); return JSON.stringify(out); } catch (e) { return 'ERR:' + e.message; } })()`);
    logrep('排名候选: ' + String(candRaw).slice(0, 1500));
    let candList = [];
    try { candList = JSON.parse(candRaw) || []; } catch (e) { }
    let clickedOK = '';
    for (const pth of candList.slice(0, 10)) {
      const nm = String(pth).split('/').pop();
      if (await click(nm)) { clickedOK = nm; break; }
      await sleep(600);
    }
    logrep('点击排名按钮: ' + (clickedOK || '(无)'));
    await sleep(4000);
    const reqs2 = await js(`(function(){ try { return JSON.stringify((window.__XR || []).filter(function(s){ return /rank|Rank/.test(s); })); } catch (e) { return 'ERR:' + e.message; } })()`);
    logrep('rank 请求: ' + String(reqs2).slice(0, 1200));
    const dump2 = await js(`(function(){ try { var out = []; function dfs(n, p, d) { if (d > 16) return; if (n.activeInHierarchy) out.push(p); var c = n.children || []; for (var i = 0; i < c.length; i++) dfs(c[i], p + '/' + c[i].name, d + 1); } dfs(cc.director.getScene(), '', 0); var hits = out.filter(function(s){ return /(rank|Rank|pmView|PmView|item|Item)/.test(s); }); return JSON.stringify({ total: out.length, hits: hits.slice(-120) }); } catch (e) { return 'ERR:' + e.message; } })()`);
    logrep('榜节点: ' + String(dump2).slice(0, 3500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_hdchou.png'), img.toPNG());
    logrep('截图 -> shots/uicheck_hdchou.png');
    fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_hdchou_report.txt'), rep.join('\n'), 'utf8');
  } else if (kind === 'battle') {
    // 战斗自检：秘境 → 挑战 → 探 imgWing（剑灵）/ imgSq（法器）状态
    await clickAt(CLICK_CLOSE, '预清理弹窗');
    await click('btnPve');
    await sleep(2500);
    await click('btnFight');
    const wingProbe = `(function(){
  try {
    var out = [];
    function dfs(n, p){
      if (!n) return;
      if (n.name === 'imgWing' || n.name === 'imgSq') {
        var sp = n.getComponent && n.getComponent(cc.Sprite);
        var wp = n.convertToWorldSpaceAR(cc.v2(0, 0));
        out.push(n.name + '@' + p + ' active=' + n.activeInHierarchy +
                 ' frame=' + (sp && sp.spriteFrame ? sp.spriteFrame.name : '(null)') +
                 ' wp=' + Math.round(wp.x) + ',' + Math.round(wp.y));
      }
      var c = n.children || [];
      for (var i = 0; i < c.length; i++) dfs(c[i], p + '/' + c[i].name);
    }
    dfs(cc.director.getScene(), '');
    return JSON.stringify(out);
  } catch (e) { return 'ERR:' + e.message; }
})()`;
    let probe = '';
    for (let i = 0; i < 16; i++) {
      await sleep(800);
      probe = await js(wingProbe);
      if (probe && probe.indexOf('imgWing') !== -1) break;
    }
    await sleep(1200);
    probe = await js(wingProbe);
    console.log('[solo] 战斗中 imgWing/imgSq: ' + probe);
  } else if (kind === 'detail' || kind === 'detailnpc') {
    // 详情页自检：斗法（竞技场）→ 点假人/官方NPC头像 → 打开个人信息 → 探十图标 + 角色形象 + 截图
    const wantNpc = kind === 'detailnpc';
    const rep = [];
    const logrep = (s) => { rep.push(s); console.log('[solo] ' + s); };
    const writeRep = () => { try { fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_detail_report.txt'), rep.join('\n'), 'utf8'); } catch (e) { } };
    // 关掉可能的弹窗（公告等）
    for (const cn of ['btnClose', 'imgClose', 'btnClose1']) { for (let i = 0; i < 3; i++) { const ok = await click(cn); if (!ok) break; await sleep(700); } }
    await sleep(500);
    // 页面错误陷阱（详情页数据应用阶段若报异常，能直接抓到）
    await js(`(function(){ window.__ERR=[]; window.addEventListener('error', function(e){ window.__ERR.push('ONERR:'+(e.message||'')+' @ '+(e.error && e.error.stack ? String(e.error.stack).split('\\n').slice(0,5).join(' | ') : '(nostack)')); }); var ce=console.error; console.error=function(){ try{ window.__ERR.push('CERR:'+Array.prototype.join.call(arguments,' ')); }catch(e){}; ce.apply(console, arguments); }; var cw=console.warn; console.warn=function(){ try{ window.__ERR.push('CWARN:'+Array.prototype.join.call(arguments,' ')); }catch(e){}; cw.apply(console, arguments); }; return 'TRAP'; })()`);
    // 直接调组件方法进竞技场（避开节点命名/文本图片化问题）
    const callComp = async (clsName, method) => {
      const r = await js(`(function(){try{
        function comps(root,name){var out=[];(function dfs(n){var c=null;try{c=n.getComponent&&n.getComponent(name);}catch(e){}if(c)out.push(c);var ch=n.children||[];for(var i=0;i<ch.length;i++)dfs(ch[i]);})(root);return out;}
        var sc=cc.director.getScene();
        var cs=comps(sc,${JSON.stringify(clsName)});
        if(!cs.length) return 'NOCOMP';
        var c=cs[0];
        if(typeof c[${JSON.stringify(method)}]!=='function') return 'NOMETHOD';
        c[${JSON.stringify(method)}]();
        return 'OK';
      }catch(e){return 'ERR:'+e.message;}})()`);
      logrep('调用 ' + clsName + '.' + method + ' => ' + r);
      return r;
    };
    await callComp('UIHomeView', 'onClickArena');
    await sleep(3000);
    await callComp('UIArenaRankView', 'onClickFight');
    await sleep(3200);
    // —— v3.3.2：刷新两次数对手（验证不再固定同一人）
    const listNames = () => js(`(function(){try{function comps(root,name){var out=[];(function dfs(n){var c=null;try{c=n.getComponent&&n.getComponent(name);}catch(e){}if(c)out.push(c);var ch=n.children||[];for(var i=0;i<ch.length;i++)dfs(ch[i]);})(root);return out;} var list=comps(cc.director.getScene(),'UIArenaFightItem'); return JSON.stringify(list.map(function(c){return c.data?String(c.data.uuid)+':'+c.data.name:'?';}));}catch(e){return 'ERR:'+e.message;}})()`);
    logrep('对手(A): ' + await listNames());
    for (let rr = 0; rr < 2; rr++) { await callComp('UIArenaView', 'onClickRefresh'); await sleep(2600); logrep('刷新#' + (rr + 1) + ': ' + await listNames()); }
    // 选目标对手（detail=假人 / detailnpc=官方NPC）并点它的头像（直接调 onClickHead）
    if (wantNpc) {
      // 官方 NPC：回到竞技场排行榜，点榜首（榜首是官方机器人，无“不可查看”限制的那条路径）
      await callComp('UIHomeView', 'onClickArena');
      await sleep(2600);
      const r3b = await js(`(function(){try{
        function comps(root,name){var out=[];(function dfs(n){var c=null;try{c=n.getComponent&&n.getComponent(name);}catch(e){}if(c)out.push(c);var ch=n.children||[];for(var i=0;i<ch.length;i++)dfs(ch[i]);})(root);return out;}
        var list=comps(cc.director.getScene(),'UIArenaRankTopItem');
        if(!list.length) return 'NO_RANK_ITEM';
        list[0].onClick();
        return 'CLICKED:'+list[0].fuuid;
      }catch(e){return 'ERR:'+e.message;}})()`);
      logrep('排行榜 NPC 点击: ' + r3b);
    } else {
      const r3 = await js(`(function(){try{
      function comps(root,name){var out=[];(function dfs(n){var c=null;try{c=n.getComponent&&n.getComponent(name);}catch(e){}if(c)out.push(c);var ch=n.children||[];for(var i=0;i<ch.length;i++)dfs(ch[i]);})(root);return out;}
      var list=comps(cc.director.getScene(),'UIArenaFightItem');
      var names=list.map(function(c){return c.data?String(c.data.uuid)+':'+(c.data.name||''):'?';});
      var pick=null;
      var WANTNPC = ${wantNpc ? 'true' : 'false'};
      for(var i=0;i<list.length;i++){ if(list[i].data&&(WANTNPC?Number(list[i].data.uuid)<100000:Number(list[i].data.uuid)>=100000)){pick=list[i];break;} }
      if(!pick) return JSON.stringify({n:list.length, names:names, picked:null});
      pick.onClickHead();
      return JSON.stringify({n:list.length, names:names, picked:String(pick.data.uuid)+':'+pick.data.name});
    }catch(e){return 'ERR:'+e.message;}})()`);
      logrep('对手列表: ' + r3);
    }
    await sleep(3200);
    const detProbe = `(function(){
      try {
        var scene = cc.director.getScene();
        var tops = [];
        (function collect(n){ var c = n.children || []; for (var i = 0; i < c.length; i++) { if (c[i].name === 'iconWing') { var p = c[i]; while (p.parent && p.parent.name !== 'Canvas') p = p.parent; tops.push({ top: p.name, act: c[i].activeInHierarchy, node: c[i] }); } collect(c[i]); } })(scene);
        var root = null, meta = tops.map(function (t) { return t.top + ':' + (t.act ? 'A' : 'x'); });
        for (var k = 0; k < tops.length; k++) { if (tops[k].top !== 'homeView') { var p2 = tops[k].node; while (p2.parent && p2.parent.name !== 'Canvas') p2 = p2.parent; root = p2; } }
        if (!root) return 'DETAIL_NOT_FOUND ' + JSON.stringify(meta);
        var out = { _root: root.name, _tops: meta, _gRoleChildren: -1, _miFaChildren: -1 };
        function dfs(n){
          if (out[n.name] === undefined) {
            var sp = null; try { sp = n.getComponent && n.getComponent(cc.Sprite); } catch (e) { }
            out[n.name] = (n.activeInHierarchy ? 'A' : 'x') + '|' + (sp && sp.spriteFrame ? String(sp.spriteFrame.name || sp.spriteFrame._name || '?') : '-');
          }
          var c = n.children || []; for (var i = 0; i < c.length; i++) dfs(c[i]);
        }
        dfs(root);
        (function g(n){ if (out._gRoleChildren < 0 && n.name === 'gRole') out._gRoleChildren = n.childrenCount; var c = n.children || []; for (var i = 0; i < c.length; i++) g(c[i]); })(root);
        (function g2(n){ if (out._miFaChildren < 0 && n.name === 'miFaContent') out._miFaChildren = n.childrenCount; var c = n.children || []; for (var i = 0; i < c.length; i++) g2(c[i]); })(root);
        return JSON.stringify(out);
      } catch (e) { return 'ERR:' + e.message; }
    })()`;
    const det = await js(detProbe);
    logrep('详情页探针: ' + det);
    const detState = await js(`(function(){try{
      function comps(root,name){var out=[];(function dfs(n){var c=null;try{c=n.getComponent&&n.getComponent(name);}catch(e){}if(c)out.push(c);var ch=n.children||[];for(var i=0;i<ch.length;i++)dfs(ch[i]);})(root);return out;}
      var cs=comps(cc.director.getScene(),'UIUserDetailView');
      if(!cs.length) return 'NOCOMP';
      var u=cs[0].userInfo;
      if(!u) return 'NO_USERINFO';
      return JSON.stringify({name:u.name, chid:u.chid, head:u.head, level:u.level, club:u.clubName, sbKeys:Object.keys(u.sevBack||{}), wing:(u.sevBack&&u.sevBack.actChiBang)?u.sevBack.actChiBang.hh:null, sq:(u.sevBack&&u.sevBack.actShengQi&&u.sevBack.actShengQi.a)?String(u.sevBack.actShengQi.a.chuan):null});
    }catch(e){return 'ERR:'+e.message;}})()`);
    logrep('详情页 userInfo: ' + detState);
    const errs = await js('JSON.stringify(window.__ERR||[])');
    logrep('页面错误: ' + errs);
    writeRep();
  } else {
    const node = kind === 'shop2' ? 'btnDiamond' : 'btnShop';
    await click(node);
    await sleep(3000);
    console.log('[solo] btnGoldBar 状态 = ' + (await state('btnGoldBar')) + '（期望 false = 已隐藏）');
  }
  await sleep(600);
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS_DIR, 'uicheck_' + kind + '.png'), img.toPNG());
    console.log('[solo] 截图 -> shots/uicheck_' + kind + '.png');
  } catch (e) { }
  await sleep(400);
  app.quit();
}

async function autotest() {
  console.log('[solo] autotest begin');
  let clicked = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    if (!win || win.isDestroyed()) { console.log('[solo] window gone'); return; }
    let r;
    try { r = await win.webContents.executeJavaScript(CLICK_PROBE); }
    catch (e) { r = 'EXECFAIL:' + e.message; }
    if (i % 5 === 0 || r === 'clicked' || r.startsWith('ERR')) console.log('[solo] probe#' + i + ' => ' + r);
    if (r === 'clicked') { clicked = true; break; }
    if (homeSeen) { console.log('[solo] 已直进主城（免点击路径生效）'); clicked = true; break; }
  }
  console.log('[solo] clicked=' + clicked);
  await sleep(1500);
  for (let k = 0; k < 40; k++) {
    if (!win || win.isDestroyed()) break;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOTS_DIR, 'shot_' + String(k).padStart(2, '0') + '.png'), img.toPNG());
    } catch (e) { console.log('[solo] shot fail: ' + e.message); }
    if (homeSeen) {
      console.log('[solo] HOME SEEN -> capture settle shots');
      await sleep(3000);
      try {
        const img2 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SHOTS_DIR, 'shot_home.png'), img2.toPNG());
      } catch (e) {}
      await tourOnce();
      break;
    }
    await sleep(4000);
  }
  console.log('[solo] autotest end. homeSeen=' + homeSeen);
  await sleep(1000);
  app.quit();
}

// 启动连拍：从页面加载开始每 400ms 拍一张（默认 60 张 ≈ 24s），进主城后多拍 4 张收尾
async function captureStartup() {
  console.log('[solo] capture-startup begin');
  let shots = 0, settled = 0;
  for (let k = 0; k < 60; k++) {
    if (!win || win.isDestroyed()) break;
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOTS_DIR, 'startup_' + String(k).padStart(2, '0') + '.png'), img.toPNG());
      shots++;
    } catch (e) { }
    if (homeSeen) { settled++; if (settled > 4) break; }
    await sleep(400);
  }
  console.log('[solo] capture-startup end，共 ' + shots + ' 张，homeSeen=' + homeSeen);
  await sleep(500);
  app.quit();
}

/* ================= 账号系统（登录 / 换号 / 列表） ================= */
const ACCOUNT_FILE = path.join(ROOT, 'account.json');
// 数据目录：默认 app/db；可用环境变量 SOLO_DB_DIR 指向别处（维护命令拿副本做安全测试用）
const DB_DIR = process.env.SOLO_DB_DIR ? String(process.env.SOLO_DB_DIR) : path.join(ROOT, 'db');

function readCurrentAccount() {
  try { return String((JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')) || {}).current || ''); }
  catch (e) { return ''; }
}
function writeCurrentAccount(name) {
  try { fs.writeFileSync(ACCOUNT_FILE, JSON.stringify({ current: String(name) }, null, 2)); } catch (e) { }
}

// 从后端数据库枚举已有账号（loginPlatform → player → user 拼出角色信息）
function collectAccounts() {
  const out = [];
  try {
    const rd = (n) => JSON.parse(fs.readFileSync(path.join(DB_DIR, 'shanhaitbkf', n + '.json'), 'utf8'));
    const lp = rd('loginPlatform'), players = rd('player'), users = rd('user');
    const pByUid = {}, uByUuid = {};
    for (const d of players) if (d.kid === 'playerInfo') pByUid[String(d.id)] = d.data || {};
    for (const d of users) if (d.kid === 'userInfo') uByUuid[String(d.id)] = d.data || {};
    for (const row of lp) {
      if (!row.openId || String(row.pid) !== '1') continue;   // 只要游戏服账号
      const uid = String(row.uid || '');
      const pi = pByUid[uid] || {};
      let uuid = '';
      try { uuid = String(((pi.list || {})['1'] || {}).uuid || ''); } catch (e) { }
      const ui = uByUuid[uuid] || {};
      out.push({
        account: String(row.openId), uid, uuid,
        name: String(ui.name || ''), level: Number(ui.level || 0),
        lastlogin: Number(ui.lastlogin || row.time || 0)
      });
    }
    // 标注「共用角色」：多个账号指向同一个角色 uuid（删号时角色档不能跟着删）
    const byUuid = {};
    for (const a of out) if (a.uuid) (byUuid[a.uuid] = byUuid[a.uuid] || []).push(a.account);
    for (const a of out) a.sharedWith = a.uuid ? byUuid[a.uuid].filter(n => n !== a.account) : [];
    out.sort((a, b) => (b.level - a.level) || (b.lastlogin - a.lastlogin));
  } catch (e) { console.log('[account] 读取账号列表失败: ' + e.message); }
  return out;
}

function tsName() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// 删除账号：移除 loginPlatform / player 行；角色(user)档只在「没有其他账号还在用」时才移除
// —— 多个账号可以指向同一个角色（uuid），删一个号绝不能把共用的角色档删掉
function deleteAccount(name) {
  try {
    const dbDir = path.join(DB_DIR, 'shanhaitbkf');
    const rd = (n) => JSON.parse(fs.readFileSync(path.join(dbDir, n + '.json'), 'utf8'));
    const wr = (n, arr) => fs.writeFileSync(path.join(dbDir, n + '.json'), JSON.stringify(arr));
    const lp = rd('loginPlatform'), players = rd('player'), users = rd('user');
    const rows = lp.filter(d => String(d.openId) === name && String(d.pid) === '1');
    if (!rows.length) return { ok: false, msg: '未找到该账号' };
    const uids = new Set(rows.map(d => String(d.uid)));

    // 1) 该账号的 player 行 + 它引用的角色 uuid
    const myUuids = new Set();
    const pKeep = [], pTrash = [];
    for (const d of players) {
      const hit = uids.has(String(d.id));
      (hit ? pTrash : pKeep).push(d);
      if (hit && d.kid === 'playerInfo') {
        for (const sid in ((d.data || {}).list || {})) myUuids.add(String(d.data.list[sid].uuid));
      }
    }

    // 2) 剩余账号引用的角色 uuid —— 这些绝不能删
    const keepUuids = new Set();
    for (const d of pKeep) {
      if (d.kid === 'playerInfo') {
        for (const sid in ((d.data || {}).list || {})) keepUuids.add(String(d.data.list[sid].uuid));
      }
    }

    // 3) 角色档：共用的留下，独占的才移除
    const uKeep = [], uTrash = [], keptChars = [], removedChars = [];
    for (const d of users) {
      const id = String(d.id);
      if ((myUuids.has(id) || uids.has(id)) && !keepUuids.has(id)) {
        uTrash.push(d);
        if (d.kid === 'userInfo') removedChars.push(id + '(Lv' + ((d.data || {}).level || '-') + ')');
      } else {
        uKeep.push(d);
        if (myUuids.has(id) && keepUuids.has(id) && d.kid === 'userInfo') keptChars.push(id + '(Lv' + ((d.data || {}).level || '-') + ')');
      }
    }

    const trashDir = path.join(ROOT, 'account-trash');
    fs.mkdirSync(trashDir, { recursive: true });
    const trashFile = path.join(trashDir, name.replace(/[^\w.\-]/g, '_') + '_' + tsName() + '.json');
    fs.writeFileSync(trashFile, JSON.stringify({ account: name, at: Math.floor(Date.now() / 1000), loginPlatform: rows, player: pTrash, user: uTrash }, null, 1));
    wr('loginPlatform', lp.filter(d => !(String(d.openId) === name && String(d.pid) === '1')));
    wr('player', pKeep);
    wr('user', uKeep);
    if (readCurrentAccount() === name) writeCurrentAccount('');
    const parts = [];
    if (keptChars.length) parts.push('角色存档已保留（其他账号还在用）：' + keptChars.join('、'));
    if (removedChars.length) parts.push('角色存档已移除：' + removedChars.join('、'));
    if (!removedChars.length && !keptChars.length) parts.push('该账号下没有角色数据');
    return { ok: true, msg: parts.join('；') + '（已备份到 account-trash）', kept: keptChars, removed: removedChars };
  } catch (e) { return { ok: false, msg: e.message }; }
}

// 存档备份（轮转：最多保留 3 份；更旧的移入系统回收站）
function rotateDbBackups(keep) {
  try {
    const root = path.join(ROOT, 'db-backups');
    if (!fs.existsSync(root)) return;
    const items = fs.readdirSync(root).map(n => {
      const p = path.join(root, n);
      let t = 0; try { t = fs.statSync(p).mtimeMs; } catch (e) { }
      return { n, p, t };
    }).sort((a, b) => b.t - a.t);
    for (const it of items.slice(keep)) {
      if (shell && shell.trashItem) {
        Promise.resolve(shell.trashItem(it.p))
          .then(() => console.log('[solo] 旧备份已移入回收站: ' + it.n))
          .catch(e => console.log('[solo] 旧备份回收失败(保留): ' + it.n + ' - ' + (e && e.message)));
      } else {
        console.log('[solo] 旧备份回收不可用(保留): ' + it.n);
      }
    }
  } catch (e) { }
}

function dbBackup(keep) {
  try {
    const root = path.join(ROOT, 'db-backups');
    fs.mkdirSync(root, { recursive: true });
    let latest = 0;
    for (const n of fs.readdirSync(root)) { try { latest = Math.max(latest, fs.statSync(path.join(root, n)).mtimeMs); } catch (e) { } }
    if (latest && Date.now() - latest < 30 * 60 * 1000) {
      console.log('[solo] 距上次备份不足 30 分钟，跳过新备份');
      rotateDbBackups(keep || 3);
      return;
    }
    const dst = path.join(root, tsName());
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(DB_DIR, dst, { recursive: true });
    console.log('[solo] 存档已备份 -> ' + dst);
    rotateDbBackups(keep || 3);
  } catch (e) { console.log('[solo] 存档备份失败: ' + e.message); }
}

// 启动时的「登录账号」窗口；opts.autoCloseMs>0 时自动选择当前账号（测试用）
function chooseAccount(opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    const cur = readCurrentAccount() || 'ZH18886938789';
    const list = collectAccounts();
    console.log('[account] 显示选择窗口，候选 ' + list.length + ' 个，当前=' + cur);
    const pw = new BrowserWindow({
      width: 560, height: 700, resizable: false, autoHideMenuBar: true,
      title: '修仙放置游戏 · 登录账号',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    const finish = (name) => {
      if (settled) return;
      settled = true;
      const safe = String(name || '').trim() || cur;
      writeCurrentAccount(safe);
      console.log('[account] 已选择: ' + safe);
      // [solo v4.46] 关键修复：立刻 hide()（同步生效、窗口马上消失），close() 推迟到游戏窗建好之后。
      //   原写法 pw.close() 在启动期会让窗口数归零 -> window-all-closed -> app.quit()，
      //   而主进程此时正被后端 boot 同步阻塞（约 10s），游戏窗永远建不出来 = 用户“点了没反应”
      try { pw.hide(); } catch (e) { }
      pickerWin = pw;
      resolve(safe);
    };
    const onDelete = (e, name) => {
      const res = deleteAccount(name);
      console.log('[account] 删除 ' + name + ' -> ' + JSON.stringify(res));
      try { pw.webContents.send('account-data', { current: readCurrentAccount(), list: collectAccounts() }); } catch (err) { }
      try { pw.webContents.send('account-deleted', res); } catch (err) { }
    };
    ipcMain.on('account-delete', onDelete);
    ipcMain.once('account-choose', (e, name) => finish(name));
    pw.on('closed', () => {
      ipcMain.removeListener('account-delete', onDelete);
      // 关闭窗口且没有选择/登录任何账号 → 取消启动（不自动进游戏）
      if (!settled) { settled = true; console.log('[account] 未选择账号 → 取消启动'); resolve(null); }
    });
    pw.loadFile(path.join(ROOT, 'account.html'));
    pw.webContents.on('console-message', (e, level, message, line) => {
      if (level >= 2) console.log('[account][renderer] ' + message + ' (line ' + line + ')');
    });
    pw.webContents.once('did-finish-load', () => {
      try { pw.webContents.send('account-data', { current: cur, list: list }); } catch (e) { }
      if (opts.smoke) {
        setTimeout(async () => {
          try {
            const before = await pw.webContents.executeJavaScript(
              'JSON.stringify({rows:document.querySelectorAll(\".row\").length,' +
              'dels:document.querySelectorAll(\".del\").length,' +
              'shareTips:document.querySelectorAll(\".share\").length,' +
              'delW:(document.querySelector(\".del\")||{}).offsetWidth||0,' +
              'delH:(document.querySelector(\".del\")||{}).offsetHeight||0,' +
              'goDisabled:document.getElementById(\"btnGo\").disabled})');
            console.log('[account] UI 自检: ' + before);
            const after = await pw.webContents.executeJavaScript(
              '(function(){var r=document.querySelector(\".row\");if(r)r.click();' +
              'return JSON.stringify({picked:document.querySelectorAll(\".row.pick\").length,' +
              'goDisabled:document.getElementById(\"btnGo\").disabled,' +
              'info:document.getElementById(\"pickinfo\").innerText.split(String.fromCharCode(10)).join(\" | \")})})()');
            console.log('[account] 选中后: ' + after);
            await new Promise(r => setTimeout(r, 300));
            const img = await pw.webContents.capturePage();
            fs.writeFileSync(path.join(SHOTS_DIR, 'accounts_ui.png'), img.toPNG());
            console.log('[account] 窗口截图 -> shots/accounts_ui.png');
          } catch (e) { console.log('[account] UI 自检失败: ' + e.message); }
        }, 1200);
        setTimeout(() => { if (!settled) { settled = true; console.log('[account] 自检结束，关闭窗口'); try { pw.close(); } catch (e) { } resolve(null); } }, 9000);
      }
    });
    if (opts.autoCloseMs > 0) setTimeout(() => finish(cur), opts.autoCloseMs);
  });
}

async function main() {
  try { fs.writeFileSync(CONSOLE_LOG, ''); } catch (e) { }   // [solo v4.46] 真正启动时才清日志
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // ---- 0) 账号窗口自检（只开窗、不动数据、不开游戏）----
  if (SMOKE_ACCOUNTS) {
    await chooseAccount({ smoke: true });
    console.log('[solo] 账号窗口自检完成，退出');
    app.quit();
    return;
  }

  // ---- 0) 维护命令（不启动游戏、不开窗口）----
  if (ARG_LIST_ACCOUNTS || ARG_DEL_ACCOUNT) {
    if (ARG_DEL_ACCOUNT) console.log('[maint] 删除 ' + ARG_DEL_ACCOUNT + ' -> ' + JSON.stringify(deleteAccount(ARG_DEL_ACCOUNT)));
    const all = collectAccounts();
    console.log('[maint] 账号数 ' + all.length + '，当前=' + (readCurrentAccount() || '(无)'));
    for (const a of all) {
      console.log('   ' + a.account.padEnd(18) + ' uid=' + String(a.uid).padEnd(9) +
        ' 角色=' + String(a.uuid || '-').padEnd(8) + ' Lv=' + String(a.level || '-').padEnd(4) +
        ' ' + (a.sharedWith.length ? ('[与 ' + a.sharedWith.join('、') + ' 共用]') : ''));
    }
    app.quit();
    return;
  }

  // ---- 1) 账号（登录系统）：命令行 --account= > 上次选择；
  //      默认直接进游戏；--accounts / --smoke-picker / 首次无账号时才弹选号窗口 ----
  let account = ARG_ACCOUNT || readCurrentAccount();
  // --capture-startup 只抑制「无账号时兜底弹窗」，显式 --accounts / --smoke-picker 仍弹（便于连拍验证选号流程）
  const needPicker = !ARG_ACCOUNT && (SHOW_ACCOUNTS || SMOKE_PICKER || (!AUTOTEST && !CAPTURE_STARTUP && !UICHECK && !account));
  if (needPicker) {
    account = await chooseAccount({ autoCloseMs: SMOKE_PICKER ? 3000 : 0 });
    if (!account) { console.log('[solo] 未选择账号，退出（不自动进游戏）'); app.quit(); return; }
  }
  if (!account) account = 'ZH18886938789';
  console.log('[solo] 当前账号: ' + account);

  // ---- 2) 存档备份（轮转：最多 3 份，更旧的移入系统回收站） ----
  dbBackup(3);

  const server = new LocalServer({ fixturesDir: FIXTURES_DIR, saveDir: path.join(ROOT, '..', 'save') });
  // 托管官方后端（app/backend/dist：原编译产物 + mongo/redis 垫片，全套 468 路由）
  try {
    const beBoot = require(path.join(ROOT, 'backend', 'dist', '_solo_boot.js'));
    const be = await beBoot.start({ dbDir: path.join(ROOT, 'db') });
    server.setBackendPort(be.port);
    console.log('[solo] 官方后端托管已启动: 127.0.0.1:' + be.port);
  } catch (e) {
    console.log('[solo] 官方后端启动失败(回退本地实现/夹具): ' + (e && e.stack || e));
  }
  ipcMain.handle('solo-api', (e, req) => server.handle(req));
  console.log('[solo] local-server ready');
  const srv = await startStatic();
  const port = srv.address().port;
  console.log('[solo] static server: http://127.0.0.1:' + port + ' (no external process)');

  win = new BrowserWindow({
    width: 540, height: 960, useContentSize: true, autoHideMenuBar: true,
    title: '修仙放置游戏 · 单机版 PoC',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: false, nodeIntegration: false, backgroundThrottling: false
    }
  });
  // [solo v4.46] 游戏窗已建好，这时关选号窗才安全（至少还有 1 个窗口），并解除启动期守卫
  if (pickerWin && !pickerWin.isDestroyed()) { try { pickerWin.close(); } catch (e) { } }
  pickerWin = null;
  BOOTING = false;

  win.webContents.on('console-message', (e, level, message) => {
    if (!message) return;
    try { fs.appendFileSync(CONSOLE_LOG, '[' + level + '] ' + String(message) + '\n'); } catch (err) { }
    if (message.indexOf('[solo') >= 0) { console.log('[renderer] ' + String(message).slice(0, 400)); }
    if (message.indexOf('open ui') >= 0) { console.log('[renderer-ui] ' + String(message).slice(0, 200)); }
    if (message.indexOf('homeView') >= 0 && message.indexOf('open ui') >= 0) homeSeen = true;
    if (/SCRIPT ERROR|Uncaught|解析回调数据失败|WebGL|failed|Failed|失败/.test(message)) { console.log('[renderer-ERR] ' + String(message).slice(0, 400)); }
  });

  win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[solo] load-fail ' + code + ' ' + desc + ' ' + url));

  const injectSrc = buildInject(account);
  win.webContents.on('dom-ready', async () => {
    try {
      const r = await win.webContents.executeJavaScript(injectSrc);
      console.log('[solo] inject => ' + r);
    } catch (e) {
      console.log('[solo] inject FAIL: ' + e.message);
    }
  });

  await win.loadURL('http://127.0.0.1:' + port + '/index.html');
  console.log('[solo] page loaded');

  watchLogin();       // 自动点游戏内「登录」（跳过登录页）
  watchEnterGame();   // 自动点「进入游戏」（单机单服，省一步手动操作；自动测试也受益）

  if (AUTOTEST) autotest().catch(e => { console.log('[solo] autotest err: ' + e.message); app.quit(); });
  if (CAPTURE_STARTUP) captureStartup().catch(e => { console.log('[solo] capture-startup err: ' + e.message); app.quit(); });
  if (UICHECK) uiCheck(UICHECK).catch(e => { console.log('[solo] uicheck err: ' + e.message); app.quit(); });
}

process.on('uncaughtException', e => { console.log('[solo] uncaught: ' + e.message); });

// [solo v4.46] 启动失败要看得见（原来 main() 失败是静默的：start "" 启动没控制台，
//   用户只看到“双击了但什么都没发生”）
function bootFail(e) {
  const msg = String((e && (e.stack || e.message)) || e);
  console.log('[solo] 启动失败: ' + msg);
  try { dialog.showErrorBox('修仙放置游戏 · 启动失败', msg.slice(0, 1500)); } catch (e2) { }
  app.quit();
}

app.on('window-all-closed', () => {
  // [solo v4.46] 启动期（游戏窗尚未建出）忽略该事件：
  //   选号窗一关就是“0 个窗口”，此时 app.quit() 会杀掉正在 boot 的进程
  if (BOOTING) { console.log('[solo] 启动中，忽略 window-all-closed'); return; }
  app.quit();
});

// [solo v4.46] 单实例锁：避免多次双击起多个实例（第二个会顺延到 57131 -> origin 变化 -> 客户端“失忆”，
//   而且两个后端会同时读写同一套 app/db 与 save/save.json）
const SINGLE_OK = app.requestSingleInstanceLock();
if (!SINGLE_OK) {
  console.log('[solo] 已有一个实例在运行，本次启动直接退出（请使用已打开的那个窗口）');
  app.quit();
} else {
  app.on('second-instance', () => {
    console.log('[solo] second-instance：聚焦已有窗口');
    try {
      if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    } catch (e) { }
  });
  app.whenReady().then(main).catch(bootFail);
}
