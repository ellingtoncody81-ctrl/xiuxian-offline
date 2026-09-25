/* 单机版 PoC —— 本地接口层（注入页面）v4
 * 原理：替换 window.XMLHttpRequest
 *  - 同源(静态服务)请求 → 透传真实 XHR（属性/事件/方法全部转发）
 *  - 其它源(游戏服 wayhttp / cfgUrl) → 优先走 Electron IPC「本地服务层」(__LOCAL_API__)；
 *    无 IPC 时（纯浏览器模式）退化为直回内嵌夹具
 *  - v4：当前账号（登录窗口选择）写入客户端存储 + 登录请求兜底改写
 */
(function () {
    if (window.__SOLO__) { console.log('[solo] already injected'); return 'already'; }
    window.__SOLO__ = true;
    // 启动画面开关：默认隐藏闪屏/登录页（直进游戏）；--keep-boot 可保留
    window.__SOLO_KEEP_BOOT = __KEEP_BOOT__;
    var FIXTURES = __FIXTURES_JSON__;
    var STATIC_ORIGIN = location.origin;
    var RealXHR = window.XMLHttpRequest;
    var stats = { req: 0, hit: 0, pass: 0, miss: [] };
    window.__SOLO_API__ = { stats: stats, routes: Object.keys(FIXTURES) };

    function routeOf(url) {
        var m = /^[a-z]+:\/\/[^\/]+(\/[^?]*)/i.exec(url);
        if (m) return m[1].replace(/^\//, '');
        return String(url).replace(/^\//, '').split('?')[0];
    }

    /* ★ 单机版：当前账号（启动时「登录账号」窗口选择，存 app/account.json）
     *   1) 注入时把账号写进客户端自己的本地存储（localStorage: model_login），
     *      并接管该键的读写 —— 游戏登录框显示/保存的都是所选账号
     *      （客户端原生"记住账号"机制；之前因静态端口随机，每次启动都是新 origin 所以失忆）
     *   2) 兜底：即使存储被客户端绕过，登录请求里的账号仍会被改写成该账号 */
    var CHOSEN_ACCOUNT = __SOLO_ACCOUNT__;
    try {
        if (CHOSEN_ACCOUNT) {
            var _origGet = localStorage.getItem.bind(localStorage);
            var _origSet = localStorage.setItem.bind(localStorage);
            var _accKey = 'model_login';
            var _seed = function () {
                var raw = _origGet(_accKey);
                var obj = raw ? JSON.parse(raw) : {};
                if (!obj || typeof obj !== 'object') { obj = {}; }
                obj.login = CHOSEN_ACCOUNT;
                _origSet(_accKey, JSON.stringify(obj));
            };
            _seed();
            localStorage.getItem = function (k) {
                if (k === _accKey) { try { _seed(); } catch (e) { } }
                return _origGet(k);
            };
            localStorage.setItem = function (k, v) {
                if (k === _accKey) {
                    try {
                        var o = JSON.parse(v);
                        if (o && typeof o === 'object') { o.login = CHOSEN_ACCOUNT; v = JSON.stringify(o); }
                    } catch (e) { }
                }
                return _origSet(k, v);
            };
            console.log('[solo] 账号已写入客户端存储: ' + CHOSEN_ACCOUNT);
        }
    } catch (e) { console.log('[solo] 账号写存储失败(走兼底改写): ' + e.message); }
    function applyFixedAccount(route, bodyStr) {
        if (!CHOSEN_ACCOUNT) return bodyStr;
        try {
            var o = JSON.parse(bodyStr || '{}');
            var changed = false;
            if (route === 'player/login' && o && Array.isArray(o.param) && o.param.length > 0 && String(o.param[0]) !== CHOSEN_ACCOUNT) {
                o.param[0] = CHOSEN_ACCOUNT; changed = true;
            } else if (route === 'player/loginPlayer' && o && o.openid !== undefined && String(o.openid) !== CHOSEN_ACCOUNT) {
                o.openid = CHOSEN_ACCOUNT; changed = true;
            }
            return changed ? JSON.stringify(o) : bodyStr;
        } catch (e) { return bodyStr; }
    }

    var PASS_PROPS = ['readyState', 'status', 'statusText', 'response', 'responseText',
        'responseType', 'timeout', 'withCredentials', 'upload'];
    var EV_PROPS = ['onreadystatechange', 'onload', 'onloadstart', 'onloadend', 'onprogress',
        'onerror', 'ontimeout', 'onabort'];

    function FakeXHR() {
        this._real = null;
        this._own = {
            readyState: 0, status: 0, statusText: '', response: null, responseText: null,
            responseType: '', timeout: 0, withCredentials: false, upload: null,
            onreadystatechange: null, onload: null, onloadstart: null, onloadend: null,
            onprogress: null, onerror: null, ontimeout: null, onabort: null
        };
        this._listeners = {};
        this._url = ''; this._method = '';
        this._intercepted = false;
    }

    PASS_PROPS.forEach(function (p) {
        Object.defineProperty(FakeXHR.prototype, p, {
            get: function () { return this._real ? this._real[p] : this._own[p]; },
            set: function (v) { if (this._real) { this._real[p] = v; } else { this._own[p] = v; } }
        });
    });
    EV_PROPS.forEach(function (p) {
        Object.defineProperty(FakeXHR.prototype, p, {
            get: function () { return this._real ? this._real[p] : this._own[p]; },
            set: function (v) { if (this._real) { this._real[p] = v; } else { this._own[p] = v; } }
        });
    });

    FakeXHR.prototype.addEventListener = function (type, fn) {
        if (this._real) return this._real.addEventListener(type, fn);
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    };
    FakeXHR.prototype.removeEventListener = function (type, fn) {
        if (this._real) return this._real.removeEventListener(type, fn);
        var arr = this._listeners[type]; if (!arr) return;
        var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1);
    };
    FakeXHR.prototype.getResponseHeader = function (k) {
        if (this._real) return this._real.getResponseHeader(k);
        return null;
    };
    FakeXHR.prototype.getAllResponseHeaders = function () {
        if (this._real) return this._real.getAllResponseHeaders();
        return '';
    };
    FakeXHR.prototype.abort = function () { if (this._real) this._real.abort(); };
    FakeXHR.prototype.setRequestHeader = function (k, v) {
        if (this._real) return this._real.setRequestHeader(k, v);
    };
    FakeXHR.prototype.overrideMimeType = function (m) {
        if (this._real) return this._real.overrideMimeType(m);
    };

    FakeXHR.prototype.open = function (method, url, async) {
        this._method = method; this._url = String(url);
        var u = this._url;
        var sameOrigin = (u.indexOf(STATIC_ORIGIN) === 0) || (u.indexOf('://') < 0);
        if (sameOrigin) {
            this._real = new RealXHR();
            return this._real.open.apply(this._real, arguments);
        }
        this._intercepted = true;
        this._own.readyState = 1;
    };

    FakeXHR.prototype.send = function (body) {
        if (this._real) { stats.pass++; return this._real.send(body); }
        var self = this;
        stats.req++;
        var route = routeOf(this._url);
        var bodyStr = (typeof body === 'string') ? body : JSON.stringify(body || {});
        bodyStr = applyFixedAccount(route, bodyStr);
        console.log('[solo] REQ#' + stats.req + ' ' + this._method + ' /' + route + ' | ' + bodyStr.slice(0, 160));

        var deliver = function (txt) {
            setTimeout(function () {
                self._own.status = 200; self._own.statusText = 'OK';
                self._own.readyState = 4; self._own.response = txt; self._own.responseText = txt;
                var fire = function (type, prop) {
                    var fn = self._own[prop];
                    if (typeof fn === 'function') { try { fn.call(self, { type: type, target: self }); } catch (e) { console.log('[solo] cb-err(' + prop + '): ' + e.message); } }
                    var arr = self._listeners[type] || [];
                    for (var i = 0; i < arr.length; i++) { try { arr[i].call(self, { type: type, target: self }); } catch (e) { } }
                };
                fire('readystatechange', 'onreadystatechange');
                fire('load', 'onload');
                fire('loadend', 'onloadend');
            }, 20);
        };

        // ① 首选：Electron 本地服务层（主进程，带可写存档）
        if (window.__LOCAL_API__) {
            try {
                window.__LOCAL_API__(route, { url: this._url, method: this._method, body: bodyStr })
                    .then(function (respText) {
                        console.log('[solo] LOCAL /' + route + ' => ' + String(respText).length + 'B');
                        deliver(respText);
                    })
                    .catch(function (e) {
                        console.log('[solo] IPC err /' + route + ': ' + (e && e.message));
                        deliver(JSON.stringify({ type: 0, win: { msg: ['[solo] IPC错误'] } }));
                    });
                return;
            } catch (e) {
                console.log('[solo] IPC throw: ' + e.message);
            }
        }

        // ② 退化：浏览器模式，直回内嵌夹具
        var fx = FIXTURES[route];
        var out;
        if (fx) {
            stats.hit++;
            out = JSON.parse(JSON.stringify(fx));
            if (out && typeof out === 'object' && typeof out.time === 'number') out.time = Math.floor(Date.now() / 1000);
            console.log('[solo] HIT /' + route + ' => ' + JSON.stringify(out).length + 'B');
        } else {
            stats.miss.push(route);
            out = { type: 0, win: { msg: ['[solo] 未实现 /' + route] }, time: Math.floor(Date.now() / 1000) };
            console.log('[solo] MISS /' + route + '  <== 需要补夹具');
        }
        deliver(JSON.stringify(out));
    };

    FakeXHR.UNSENT = 0; FakeXHR.OPENED = 1; FakeXHR.HEADERS_RECEIVED = 2; FakeXHR.LOADING = 3; FakeXHR.DONE = 4;

    window.XMLHttpRequest = FakeXHR;
    console.log('[solo] injected v3. ipc=' + (!!window.__LOCAL_API__) + ' routes=' + Object.keys(FIXTURES).length);
    return 'injected';
})();
