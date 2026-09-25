"use strict";
/**
 * [单机版垫片 v2] redis.js —— 内存实现 + 关键数据落盘
 * ------------------------------------------------------------------
 * v2 变更（2026-09-18）：“斗法积分大退重置为 1500”根因修复——
 *   原版垫片纯内存，重启即丢；而排行榜（zset）没有 mongo 镜像，
 *   导致玩家竞技分/斗罗分/洞天榜等全部丢失。
 *   现在：zset + kv 自动落盘（debounce 700ms + exit 兜底），
 *   文件 <dbDir>/solo_redis_ph.json / solo_redis_yw1.json；
 *   hash 不存（模块数据走官方 mongo 双写，磁盘已有镜像）。
 *
 * 替换原版（原文件已改名 redis.js.orig-bak 保留）。
 * 对外导出与原版一致：redisSev（内含 rdss.ph / rdss.yw1）。
 * 语义对齐要点：
 *   - hGet/hSet/hmSet/hGetAll/hdel：对象值写入时 JSON.stringify（与原版一致）
 *   - set(key,val) / set(key,val,'nx','px',ms) 支持 NX + 毫秒过期（锁用）
 *   - lock/unLock：单机单进程，直接授予锁（跳过原版 10 次重试等待）
 *   - z* 排序集合：内存实现，返回格式对齐 node-redis v2（WITHSCORES 为扁平数组）
 */
const fs = require("fs");
const path = require("path");

class Redis {
    constructor(name) {
        this.name = name || "rw";
        this.kv = {};      // string -> {v, e(过期时间戳,0=永久)}
        this.hash = {};    // key -> {field: string}
        this.zset = {};    // key -> {member: score}
        this._dirty = false;
        this._timer = null;
    }
    _file() {
        const dbDir = process.env.SOLO_DB_DIR || path.join(__dirname, "..", "..", "db");
        return path.join(dbDir, "solo_redis_" + this.name + ".json");
    }
    _load() {
        try {
            const d = JSON.parse(fs.readFileSync(this._file(), "utf8"));
            this.zset = d.zset || {};
            this.kv = d.kv || {};
            console.log("[solo-redis] 持久化加载 " + this.name + "（榜 " + Object.keys(this.zset).length + " 个 / kv " + Object.keys(this.kv).length + " 个）");
        } catch (e) { /* 首次运行无文件 */ }
    }
    _saveSync() {
        try {
            fs.mkdirSync(path.dirname(this._file()), { recursive: true });
            fs.writeFileSync(this._file(), JSON.stringify({ zset: this.zset, kv: this.kv }));
        } catch (e) { }
    }
    _mark() {
        this._dirty = true;
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            if (this._dirty) { this._dirty = false; this._saveSync(); }
        }, 700);
        try { this._timer.unref && this._timer.unref(); } catch (e) { }
    }
    connect(cfg) {
        console.log("[solo-redis] 内存模式就绪" + (this.name ? " [" + this.name + "]" : ""), cfg && cfg.host ? (cfg.host + ":" + cfg.port) : "");
        this._load();
        process.on("exit", () => { if (this._dirty) this._saveSync(); });
        return Promise.resolve(true);
    }
    _str(v) { return (v !== null && typeof v === "object") ? JSON.stringify(v) : v; }
    // 与官方封装一致：读时 JSON.parse（失败则回退原串）
    _parse(v) {
        if (v == null) return null;
        if (typeof v !== "string") return v;
        try { return JSON.parse(v); } catch (e) { return v; }
    }

    // ----- KV -----
    async set(key, value, ...args) {
        const la = args.map(a => String(a).toLowerCase());
        const nx = la.indexOf("nx") !== -1;
        if (nx && this.kv[key] !== undefined) return null;
        const rec = { v: this._str(value), e: 0 };
        const pxIdx = la.indexOf("px");
        if (pxIdx !== -1 && args[pxIdx + 1] != null) rec.e = Date.now() + Number(args[pxIdx + 1]);
        this.kv[key] = rec;
        this._mark();
        return "OK";
    }
    async get(key) {
        const r = this.kv[key];
        if (!r) return null;
        if (r.e && r.e < Date.now()) { delete this.kv[key]; return null; }
        return this._parse(r.v);
    }
    async setnx(key, value) {
        if (this.kv[key] !== undefined) return false;
        this.kv[key] = { v: this._str(value), e: 0 };
        this._mark();
        return true;
    }
    async del(key) {
        const ks = Array.isArray(key) ? key : [key];
        let n = 0;
        for (const k of ks) {
            if (k in this.kv) { delete this.kv[k]; n++; }
            if (k in this.hash) { delete this.hash[k]; n++; }
            if (k in this.zset) { delete this.zset[k]; n++; }
        }
        if (n > 0) this._mark();
        return n;
    }
    async delall() { this.kv = {}; this.hash = {}; this.zset = {}; this._mark(); return "OK"; }
    async getKeys(pattern = "*") {
        const all = new Set(Object.keys(this.kv).concat(Object.keys(this.hash), Object.keys(this.zset)));
        const re = new RegExp("^" + String(pattern).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
        return Array.from(all).filter(k => re.test(k));
    }

    // ----- Hash -----
    async hGet(key, field) {
        const h = this.hash[key];
        if (!h) return null;
        const v = h[field];
        return v === undefined ? null : this._parse(v);
    }
    async hSet(key, field, value) {
        (this.hash[key] = this.hash[key] || {})[field] = this._str(value);
        return true;
    }
    async hmSet(key, fields) {
        const h = this.hash[key] = this.hash[key] || {};
        for (const k in fields) h[k] = this._str(fields[k]);
        return true;
    }
    async hGetAll(key) {
        const h = this.hash[key];
        return h ? Object.assign({}, h) : null;
    }
    async hdel(key, field) {
        const h = this.hash[key];
        if (!h) return true;
        const fs_ = Array.isArray(field) ? field : [field];
        for (const f of fs_) delete h[f];
        return true;
    }

    // ----- 排序集合 -----
    _z(key) { return this.zset[key] = this.zset[key] || {}; }
    _zlist(key, desc) {
        const z = this.zset[key] || {};
        const l = Object.keys(z).map(m => ({ value: m, score: z[m] }));
        l.sort((a, b) => desc ? (b.score - a.score) : (a.score - b.score));
        return l;
    }
    async zAdd(key, score, member) {
        const z = this._z(key);
        const add = z[member] === undefined ? 1 : 0;
        z[member] = Number(score) || 0;
        this._mark();
        return add;
    }
    async zAddArr(key, arr) {
        const z = this._z(key);
        let n = 0;
        const list = Array.isArray(arr) ? arr : [arr];
        // [v4.54] 官方契约：arr = [score, member, score, member, ...]
        //   依据：RModel.zSetVals 注释「@param arr [score,member,score,member,....]」
        //        + crontab/timer.js 周日 jjcDay 周榜初始化（push(score) 后 push(member)）
        //        + timer.js 登神榜跨服拷贝（saveData_Kua 同样 score 在前）
        //   旧实现把"每个元素都当成成员"、统一写 score=Date.now()，被周日定时任务触发后：
        //     ① 分值串（1500 / 1499.9999999…）被当成榜成员 → 斗法榜混入 3700 个浮点成员
        //     ② 真成员（含玩家）拿到 score=毫秒时间戳 → 「斗法积分 = 1789840274760」
        //        → 登录读榜时把该成员当 jjcNpc 表 key → /player/loginPlayer 500 → 客户端黑屏
        if (list.length % 2 !== 0) {
            console.warn("[solo-redis] zAddArr 参数长度为奇数（应为 [score,member,...] 成对）key=" + key + " len=" + list.length);
        }
        for (let i = 0; i + 1 < list.length; i += 2) {
            const score = Number(list[i]);
            const member = String(list[i + 1]);
            if (z[member] === undefined) n++;
            z[member] = isNaN(score) ? 0 : score;
        }
        this._mark();
        return n;
    }
    async zScore(key, member) {
        const z = this.zset[key] || {};
        return z[member] === undefined ? null : String(z[member]);
    }
    async zCount(key, min, max) {
        const list = this._zlist(key, false);
        const lo = min === "-inf" ? -Infinity : Number(min);
        const hi = max === "+inf" ? Infinity : Number(max);
        return list.filter(x => x.score >= lo && x.score <= hi).length;
    }
    async zRem(key, members) {
        const z = this.zset[key] || {};
        const ms = Array.isArray(members) ? members : [members];
        let n = 0;
        for (const m of ms) if (m in z) { delete z[m]; n++; }
        if (n > 0) this._mark();
        return n;
    }
    async zRank(key, member) {
        const i = this._zlist(key, false).findIndex(x => x.value === member);
        return i === -1 ? null : i;
    }
    async zRevrank(key, member) {
        const i = this._zlist(key, true).findIndex(x => x.value === member);
        return i === -1 ? null : i;
    }
    async zRevrange(key, start, end) {
        return sliceMembers(this._zlist(key, true), start, end).map(x => x.value);
    }
    async zRange(key, start, end) {
        return sliceMembers(this._zlist(key, false), start, end).map(x => x.value);
    }
    async zRevrangeWithScores(key, start, end) {
        const flat = [];
        for (const x of sliceMembers(this._zlist(key, true), start, end)) { flat.push(x.value, String(x.score)); }
        return flat;
    }
    async zRangeWithScores(key, start, end) {
        const flat = [];
        for (const x of sliceMembers(this._zlist(key, false), start, end)) { flat.push(x.value, String(x.score)); }
        return flat;
    }
    _byScore(key, min, max) {
        const lo = (min === "-inf" || min == null) ? -Infinity : Number(min);
        const hi = (max === "+inf" || max == null) ? Infinity : Number(max);
        return this._zlist(key, false).filter(x => x.score >= lo && x.score <= hi);
    }
    async zRangeByScore(key, min, max) {
        return this._byScore(key, min, max).map(x => x.value);
    }
    async zRangeByScorewithScore(key, min, max) {
        const flat = [];
        for (const x of this._byScore(key, min, max)) { flat.push(x.value, String(x.score)); }
        return flat;
    }

    // ----- 锁 -----
    async lock(fuuid, key) {
        // 单机单进程：直接授予（带 2 秒过期自愈），不与原版 10×100ms 重试较劲
        await this.set(key, fuuid, "px", 2000);
        return true;
    }
    async unLock(fuuid, key) {
        const v = await this.get(key);
        if (v === fuuid) await this.del(key);
    }
}

function sliceMembers(list, start, end) {
    const L = list.length;
    let s = start < 0 ? Math.max(L + start, 0) : start;
    let e = end < 0 ? L + end : end;
    if (e >= L) e = L - 1;
    if (s > e || s >= L) return [];
    return list.slice(s, e + 1);
}

class RedisSev {
    constructor() { this.rdss = {}; }
    async init() {
        this.rdss["ph"] = new Redis("ph");
        await this.rdss["ph"].connect({});
        this.rdss["yw1"] = new Redis("yw1");
        await this.rdss["yw1"].connect({});
        return true;
    }
    getRedis(type) {
        try {
            const dt = require("./master").DataType;
            if (dt) {
                if (type === dt.player || type === dt.user || type === dt.sev) return this.rdss["yw1"];
                if (type === dt.rds || type === dt.system) return this.rdss["ph"];
            }
        } catch (e) { }
        return this.rdss["yw1"] || this.rdss["ph"];
    }
}

const redisSev = new RedisSev();
exports.Redis = Redis;
exports.RedisSev = RedisSev;
exports.redisSev = redisSev;
