"use strict";
/**
 * [单机版垫片 v1] mongodb.js —— JSON 文件模块数据库
 * ------------------------------------------------------------------
 * 替换原版（原文件已改名 mongodb.js.orig-bak 保留）。
 * 对外导出与原版完全一致：MongoDb / DbSev / dbSev。
 * 语义对齐要点：
 *   - update()      = $set 局部合并（原版实现即 { $set: update }）
 *   - newUpdate()   = 原样语句：带 $ 操作符则应用，否则整文档替换（保留 _id）
 *   - replace()     = $set 合并 + upsert:true（原版即如此）
 *   - updateRemove()= $unset 删字段
 *   - remove()      = singleDel=true 删全部匹配，否则只删第一条
 *   - getNextId()   = table_count 集合 {name, points} 自增
 *   - 数据按“每个集合一个 JSON 文件”落盘；写操作标脏，flushSync() 落盘
 */
const fs = require("fs");
const path = require("path");

// ---------- 工具 ----------
function isPlainObject(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function deepClone(v) { try { return v === undefined ? v : JSON.parse(JSON.stringify(v)); } catch (e) { return v; } }
function eqVal(a, b) {
    if (a === b) return true;
    if (a === undefined || a === null || b === undefined || b === null) return false;
    if (typeof a === "object" || typeof b === "object") {
        try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
    }
    return String(a) === String(b); // 宽松：数字/字符串同值可比（uuid 两边类型混用）
}
function cmpVal(a, b) {
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na < nb ? -1 : (na > nb ? 1 : 0);
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
}
function getPath(doc, p) {
    let cur = doc;
    for (const k of String(p).split(".")) {
        if (cur == null) return undefined;
        cur = cur[k];
    }
    return cur;
}
function setPath(doc, p, val) {
    const ks = String(p).split(".");
    let cur = doc;
    for (let i = 0; i < ks.length - 1; i++) {
        if (!isPlainObject(cur[ks[i]]) && !Array.isArray(cur[ks[i]])) cur[ks[i]] = {};
        cur = cur[ks[i]];
    }
    cur[ks[ks.length - 1]] = val;
}
function unsetPath(doc, p) {
    const ks = String(p).split(".");
    let cur = doc;
    for (let i = 0; i < ks.length - 1; i++) {
        cur = cur[ks[i]];
        if (cur == null) return;
    }
    if (isPlainObject(cur)) delete cur[ks[ks.length - 1]];
}

// ---------- 匹配 ----------
function matchOp(docVal, op, arg) {
    switch (op) {
        case "$eq": return matchField(docVal, arg);
        case "$ne": return !matchField(docVal, arg);
        case "$gt": return docVal !== undefined && docVal !== null && cmpVal(docVal, arg) > 0;
        case "$gte": return docVal !== undefined && docVal !== null && cmpVal(docVal, arg) >= 0;
        case "$lt": return docVal !== undefined && docVal !== null && cmpVal(docVal, arg) < 0;
        case "$lte": return docVal !== undefined && docVal !== null && cmpVal(docVal, arg) <= 0;
        case "$in":
            return Array.isArray(arg) && arg.some(x => Array.isArray(docVal) ? docVal.some(y => eqVal(y, x)) : eqVal(docVal, x));
        case "$nin":
            return Array.isArray(arg) && !arg.some(x => Array.isArray(docVal) ? docVal.some(y => eqVal(y, x)) : eqVal(docVal, x));
        case "$exists": return (docVal !== undefined) === !!arg;
        case "$regex": {
            const re = arg instanceof RegExp ? arg : new RegExp(arg);
            return typeof docVal === "string" && re.test(docVal);
        }
        case "$size": return Array.isArray(docVal) && docVal.length === arg;
        case "$not": return !matchField(docVal, arg);
        default: return false;
    }
}
function matchField(docVal, cond) {
    if (isPlainObject(cond)) {
        const keys = Object.keys(cond);
        if (keys.length > 0 && keys.every(k => k[0] === "$")) {
            return keys.every(k => matchOp(docVal, k, cond[k]));
        }
    }
    if (Array.isArray(docVal) && !Array.isArray(cond)) return docVal.some(v => eqVal(v, cond));
    return eqVal(docVal, cond);
}
function matchDoc(doc, q) {
    if (!q) return true;
    for (const k of Object.keys(q)) {
        if (k === "$or") { if (!q[k].some(sub => matchDoc(doc, sub))) return false; continue; }
        if (k === "$and") { if (!q[k].every(sub => matchDoc(doc, sub))) return false; continue; }
        if (k === "$nor") { if (q[k].some(sub => matchDoc(doc, sub))) return false; continue; }
        if (!matchField(getPath(doc, k), q[k])) return false;
    }
    return true;
}
function stripQueryOps(q) {
    const out = {};
    if (!q) return out;
    for (const k of Object.keys(q)) {
        if (k[0] !== "$" && !isPlainObject(q[k])) out[k] = q[k];
    }
    return out;
}

// ---------- 更新操作 ----------
function hasOps(u) { return isPlainObject(u) && Object.keys(u).some(k => k[0] === "$"); }
function applyOperators(doc, u) {
    let changed = false;
    if (u.$set) for (const k of Object.keys(u.$set)) { setPath(doc, k, deepClone(u.$set[k])); changed = true; }
    if (u.$inc) for (const k of Object.keys(u.$inc)) {
        const old = getPath(doc, k);
        setPath(doc, k, (old == null ? 0 : Number(old)) + Number(u.$inc[k]));
        changed = true;
    }
    if (u.$unset) for (const k of Object.keys(u.$unset)) { unsetPath(doc, k); changed = true; }
    if (u.$push) for (const k of Object.keys(u.$push)) {
        let arr = getPath(doc, k);
        if (!Array.isArray(arr)) { arr = []; setPath(doc, k, arr); }
        arr.push(deepClone(u.$push[k]));
        changed = true;
    }
    if (u.$pull) for (const k of Object.keys(u.$pull)) {
        const arr = getPath(doc, k);
        if (Array.isArray(arr)) { const i = arr.findIndex(x => eqVal(x, u.$pull[k])); if (i >= 0) { arr.splice(i, 1); changed = true; } }
    }
    if (u.$addToSet) for (const k of Object.keys(u.$addToSet)) {
        let arr = getPath(doc, k);
        if (!Array.isArray(arr)) { arr = []; setPath(doc, k, arr); }
        if (!arr.some(x => eqVal(x, u.$addToSet[k]))) { arr.push(deepClone(u.$addToSet[k])); changed = true; }
    }
    return changed;
}

let _oid = 0;
function nextOid() { _oid++; return "solo" + Date.now().toString(36) + "_" + _oid; }

function baseDir() {
    return process.env.SOLO_DB_DIR || path.join(__dirname, "..", "..", "_solo_db");
}

// ---------- MongoDb ----------
class MongoDb {
    constructor(dbName, dir) {
        this.dbName = dbName || "solo";
        this._base = dir || null;
        this._tables = {};
        this._dirty = new Set();
        this.db = true; // 兼容原代码对 this.db 的空值检查（模型层从不直接访问）
        this.client = true;
    }
    _dir() { return path.join(this._base || baseDir(), this.dbName); }
    _file(t) { return path.join(this._dir(), t + ".json"); }
    _table(t) {
        if (!this._tables[t]) {
            let arr = [];
            const f = this._file(t);
            if (fs.existsSync(f)) {
                try { arr = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { console.error("[solo-db] 解析失败", f, e.message); arr = []; }
            }
            if (!Array.isArray(arr)) arr = [];
            this._tables[t] = arr;
        }
        return this._tables[t];
    }
    _mark(t) { this._dirty.add(t); }
    _tableNames() {
        const s = new Set(Object.keys(this._tables));
        try {
            const dir = this._dir();
            if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) s.add(f.slice(0, -5));
        } catch (e) { }
        return Array.from(s);
    }
    flushSync() {
        if (!this._dirty.size) return;
        const dir = this._dir();
        try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
        for (const t of this._dirty) {
            try { fs.writeFileSync(this._file(t), JSON.stringify(this._tables[t] || [])); }
            catch (e) { console.error("[solo-db] 写入失败", t, e.message); }
        }
        this._dirty.clear();
    }

    async connect(cfg) {
        if (cfg && cfg.name) this.dbName = cfg.name;
        try { fs.mkdirSync(this._dir(), { recursive: true }); } catch (e) { }
        console.log("[solo-db] 就绪(文件模式)", this.dbName, "->", this._dir());
        return true;
    }
    async close() { this.flushSync(); return true; }

    async findOne(table, query = {}, options = {}) {
        const hit = this._table(table).find(d => matchDoc(d, query));
        return hit ? deepClone(hit) : null;
    }
    async find(table, query = {}, options = {}) {
        return this._table(table).filter(d => matchDoc(d, query)).map(deepClone);
    }
    async findCursor(table, query = {}, options = {}) {
        return this._table(table).filter(d => matchDoc(d, query)).map(deepClone);
    }
    async findCount(table, query = {}, options = {}) {
        return this._table(table).filter(d => matchDoc(d, query)).length;
    }
    async findLimit(table, query = {}, options = {}, limit = 100) {
        return this._table(table).filter(d => matchDoc(d, query)).slice(0, limit).map(deepClone);
    }

    async insert(table, doc = {}) {
        const arr = this._table(table);
        const d = deepClone(doc);
        if (d._id === undefined) d._id = nextOid();
        arr.push(d);
        this._mark(table);
        return d._id;
    }
    async insertMany(table, docs = []) {
        const arr = this._table(table);
        const ids = [];
        for (const doc of docs) {
            const d = deepClone(doc);
            if (d._id === undefined) d._id = nextOid();
            arr.push(d); ids.push(d._id);
        }
        this._mark(table);
        return { insertedCount: docs.length, insertedIds: ids, result: { ok: 1, n: docs.length } };
    }

    async update(table, query = {}, upd = {}, upsert = false, multi = false) {
        const arr = this._table(table);
        let n = 0, nMod = 0, upserted = 0;
        for (const d of arr) {
            if (matchDoc(d, query)) {
                if (applyOperators(d, { $set: upd })) nMod++;
                n++;
                if (!multi) break;
            }
        }
        if (n === 0 && upsert) {
            const d = Object.assign({}, stripQueryOps(query), deepClone(upd));
            if (d._id === undefined) d._id = nextOid();
            arr.push(d); upserted = 1;
        }
        if (n || upserted) this._mark(table);
        return { result: { ok: 1, n: n || upserted, nModified: nMod }, modifiedCount: nMod, matchedCount: n, upsertedCount: upserted, upsertedId: null };
    }

    async newUpdate(table, query = {}, upd = {}, upsert = false, multi = false) {
        const arr = this._table(table);
        let n = 0, nMod = 0, upserted = 0;
        for (const d of arr) {
            if (matchDoc(d, query)) {
                if (hasOps(upd)) { if (applyOperators(d, upd)) nMod++; }
                else {
                    const keepId = d._id;
                    for (const k of Object.keys(d)) delete d[k];
                    Object.assign(d, deepClone(upd));
                    if (d._id === undefined) d._id = keepId;
                }
                n++;
                if (!multi) break;
            }
        }
        if (n === 0 && upsert) {
            const d = Object.assign({}, stripQueryOps(query), deepClone(upd));
            if (d._id === undefined) d._id = nextOid();
            arr.push(d); upserted = 1;
        }
        if (n || upserted) this._mark(table);
        return { result: { ok: 1, n: n || upserted, nModified: nMod }, modifiedCount: nMod, matchedCount: n, upsertedCount: upserted, upsertedId: null };
    }

    async updateRemove(table, query = {}, unset = {}, multi = false) {
        const arr = this._table(table);
        let n = 0, nMod = 0;
        for (const d of arr) {
            if (matchDoc(d, query)) {
                if (applyOperators(d, { $unset: unset })) nMod++;
                n++;
                if (!multi) break;
            }
        }
        if (n) this._mark(table);
        return { result: { ok: 1, n: n, nModified: nMod }, modifiedCount: nMod, matchedCount: n };
    }

    async replace(table, query = {}, upd = {}) {
        return this.update(table, query, upd, true, false);
    }

    async remove(table, query = {}, singleDel = false) {
        const arr = this._table(table);
        let removed = 0;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (matchDoc(arr[i], query)) {
                arr.splice(i, 1);
                removed++;
                if (!singleDel) break; // 与原版一致：singleDel=false 只删一条
            }
        }
        if (removed) this._mark(table);
        return { result: { ok: 1, n: removed }, deletedCount: removed };
    }

    async getNextId(key) {
        const arr = this._table("table_count");
        let doc = arr.find(d => d.name === key);
        if (!doc) { doc = { _id: nextOid(), name: key, points: 0 }; arr.push(doc); }
        doc.points = (Number(doc.points) || 0) + 1;
        this._mark("table_count");
        return doc.points;
    }

    async collections() { return this._tableNames().map(name => ({ name })); }
    async getAllCollection() { return this._tableNames(); }
    async dropExistTable(table) { this._tables[table] = []; this._mark(table); return true; }
    async drop(table) { return true; }
    async dropIndexes(table) { return true; }
    async createIndexes(table, query = {}) { return "ok"; }
    async indexes(table) { return []; }
    async createIndex(tableName, field = {}, option = {}) { return true; }
    async whetherExistIndex(collection, index) { return false; }
    async createCollection(collection, option = {}) { this._table(collection); return true; }
    deleteDataBase() { console.warn("[solo-db] deleteDataBase 已忽略（防止单机数据被清空）"); return Promise.resolve(true); }
}

// ---------- DbSev ----------
class DbSev {
    constructor() { this.dbs = {}; }
    async init() {
        let cfg = null;
        try { cfg = require(path.join(__dirname, "..", "..", "config", "config.json")); } catch (e) { console.error("[solo-db] 读配置失败", e.message); }
        const dataName = (cfg && cfg.mongoDb && cfg.mongoDb.data && cfg.mongoDb.data.name) || "shanhaitbkf";
        const flowName = (cfg && cfg.mongoDb && cfg.mongoDb.flow && cfg.mongoDb.flow.name) || "shanhaitbkfflow";
        this.dbs["data"] = new MongoDb(dataName, null);
        await this.dbs["data"].connect({ name: dataName });
        this.dbs["flow"] = new MongoDb(flowName, null);
        await this.dbs["flow"].connect({ name: flowName });
        return true;
    }
    getDataDb() { return this.dbs["data"]; }
    getFlowDb() { return this.dbs["flow"]; }
    flushSync() { for (const k in this.dbs) { try { this.dbs[k].flushSync(); } catch (e) { } } }
}

const dbSev = new DbSev();
process.on("exit", () => { try { dbSev.flushSync(); } catch (e) { } });

exports.MongoDb = MongoDb;
exports.DbSev = DbSev;
exports.dbSev = dbSev;
